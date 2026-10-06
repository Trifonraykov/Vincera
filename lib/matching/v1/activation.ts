import "server-only"

import { eq } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { writeAdminAudit } from "@/lib/admin/audit"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { matchingConfig } from "@/lib/db/schema"
import { track } from "@/lib/events/track"

import { V0_MODEL_VERSION, v1GateReason, type MatchingFlagEnv } from "../config"

/**
 * Switching the model that ranks (CLAUDE.md §19.38 "Flag"): one transaction deactivates the old
 * row, activates the new one (`activated_at` / `activated_by_user_id`), writes the audit row
 * (`matching.model_activated`, or `matching.model_deactivated` for the row switched off) and
 * `matching.model_activated { forced }`. Deactivating a v1 row re-activates v0.
 *
 * Activation does not bypass the gate: a v1 row marked active ranks only once ≥ 50 launches went
 * live (or with `MATCHING_V1_FORCE` outside production); `forced` records that the force flag let
 * it rank early.
 */

export const ACTIVATION_MESSAGES = {
  notFound: "That model version no longer exists.",
  alreadyActive: "That model version is already active.",
  notActive: "That model version is not the active one.",
  v0: "v0 is the baseline. Activate another version instead of switching v0 off.",
} as const

type Row = { id: string; modelVersion: string; kind: "weighted" | "logistic"; active: boolean }

async function lockRows(tx: Tx): Promise<Row[]> {
  return tx
    .select({
      id: matchingConfig.id,
      modelVersion: matchingConfig.modelVersion,
      kind: matchingConfig.kind,
      active: matchingConfig.active,
    })
    .from(matchingConfig)
    .for("update")
}

async function switchTo(
  tx: Tx,
  input: { adminUserId: string; from: Row | null; to: Row; flags: MatchingFlagEnv },
  auditAction: "matching.model_activated" | "matching.model_deactivated",
): Promise<{ modelVersion: string; previousVersion: string | null; forced: boolean }> {
  const at = now()
  if (input.from) {
    await tx
      .update(matchingConfig)
      .set({ active: false })
      .where(eq(matchingConfig.id, input.from.id))
  }
  await tx
    .update(matchingConfig)
    .set({ active: true, activatedAt: at, activatedByUserId: input.adminUserId })
    .where(eq(matchingConfig.id, input.to.id))
  const forced =
    input.to.kind === "logistic" &&
    input.flags.MATCHING_V1_FORCE &&
    (await v1GateReason(tx, { MATCHING_V1_FORCE: false })) !== null
  const audited = auditAction === "matching.model_deactivated" && input.from ? input.from : input.to
  await writeAdminAudit(tx, {
    adminUserId: input.adminUserId,
    action: auditAction,
    targetType: "matching_config",
    targetId: audited.id,
    before: {
      active_version: input.from?.modelVersion ?? null,
    },
    after: {
      active_version: input.to.modelVersion,
      forced,
    },
  })
  await track(
    "matching.model_activated",
    {
      actorUserId: input.adminUserId,
      subjectType: "matching_config",
      subjectId: input.to.id,
      properties: {
        model_version: input.to.modelVersion,
        previous_version: input.from?.modelVersion ?? null,
        forced,
      },
    },
    tx,
  )
  return {
    modelVersion: input.to.modelVersion,
    previousVersion: input.from?.modelVersion ?? null,
    forced,
  }
}

/** Make `modelVersion` the active row. */
export async function activateMatchingModel(
  database: DbOrTx,
  input: { adminUserId: string; modelVersion: string; flags: MatchingFlagEnv },
): Promise<{ modelVersion: string; previousVersion: string | null; forced: boolean }> {
  return withTransaction(async (tx) => {
    const rows = await lockRows(tx)
    const to = rows.find((row) => row.modelVersion === input.modelVersion)
    if (!to) throw new ActionError(ACTIVATION_MESSAGES.notFound)
    if (to.active) throw new ActionError(ACTIVATION_MESSAGES.alreadyActive)
    const from = rows.find((row) => row.active) ?? null
    return switchTo(
      tx,
      { adminUserId: input.adminUserId, from, to, flags: input.flags },
      "matching.model_activated",
    )
  }, database)
}

/** Switch the active (non-v0) row off; v0 becomes active again. */
export async function deactivateMatchingModel(
  database: DbOrTx,
  input: { adminUserId: string; modelVersion: string; flags: MatchingFlagEnv },
): Promise<{ modelVersion: string; previousVersion: string | null; forced: boolean }> {
  return withTransaction(async (tx) => {
    const rows = await lockRows(tx)
    const from = rows.find((row) => row.modelVersion === input.modelVersion)
    if (!from) throw new ActionError(ACTIVATION_MESSAGES.notFound)
    if (from.modelVersion === V0_MODEL_VERSION) throw new ActionError(ACTIVATION_MESSAGES.v0)
    if (!from.active) throw new ActionError(ACTIVATION_MESSAGES.notActive)
    const to = rows.find((row) => row.modelVersion === V0_MODEL_VERSION)
    if (!to) throw new ActionError(ACTIVATION_MESSAGES.notFound)
    return switchTo(
      tx,
      { adminUserId: input.adminUserId, from, to, flags: input.flags },
      "matching.model_deactivated",
    )
  }, database)
}
