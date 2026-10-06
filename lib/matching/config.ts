import "server-only"

import { count, eq, isNotNull } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { launches, matchingConfig } from "@/lib/db/schema"
import type { MatchingModel, MatchWeights } from "@/lib/db/schema/types"
import { env } from "@/lib/env"

import { matchWeightsSchema, type RankingModel } from "./score"
import { matchingModelSchema } from "./v1/model"

/**
 * The model the platform ranks with (§8: weights live in `matching_config` with a version;
 * CLAUDE.md §19.38 "Flag"). `requestedVersion` is what the configuration asked for; when that is
 * a v1 (logistic) version that may not rank yet, v0 ranks and `fallbackReason` says why.
 */
export type ActiveMatchingConfig = RankingModel & {
  modelVersion: string
  kind: "weighted" | "logistic"
  requestedVersion: string
  fallbackReason: string | null
}

/** §8: v1 replaces v0 only once this many launches went live. */
export const MIN_COMPLETED_LAUNCHES_FOR_V1 = 50
/** The version v0 is stored under (migration 0003). */
export const V0_MODEL_VERSION = "v0"

export class MatchingConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MatchingConfigError"
  }
}

export type MatchingFlagEnv = {
  MATCHING_MODEL_VERSION?: string | undefined
  MATCHING_V1_FORCE: boolean
}

type ConfigRow = {
  modelVersion: string
  kind: "weighted" | "logistic"
  weights: unknown
  model: unknown
}

const configColumns = {
  modelVersion: matchingConfig.modelVersion,
  kind: matchingConfig.kind,
  weights: matchingConfig.weights,
  model: matchingConfig.model,
}

/** Zod-check a row's weights (and model): a broken config fails the job loudly. */
function parseRow(row: ConfigRow): { weights: MatchWeights; model: MatchingModel | null } {
  const weights = matchWeightsSchema.safeParse(row.weights)
  if (!weights.success) {
    throw new MatchingConfigError(`matching_config ${row.modelVersion} has invalid weights`)
  }
  if (row.kind !== "logistic") return { weights: weights.data, model: null }
  const model = matchingModelSchema.safeParse(row.model)
  if (!model.success) {
    throw new MatchingConfigError(`matching_config ${row.modelVersion} has an invalid model`)
  }
  return { weights: weights.data, model: model.data }
}

async function loadRow(database: DbOrTx, modelVersion: string): Promise<ConfigRow | null> {
  const [row] = await database
    .select(configColumns)
    .from(matchingConfig)
    .where(eq(matchingConfig.modelVersion, modelVersion))
    .limit(1)
  return row ?? null
}

/** Launches that went live at least once ("completed launches", §8 Phase 7). */
export async function countCompletedLaunches(database: DbOrTx): Promise<number> {
  const [row] = await database
    .select({ value: count() })
    .from(launches)
    .where(isNotNull(launches.wentLiveAt))
  return row?.value ?? 0
}

/** Why a v1 version may not rank right now, or null when it may (CLAUDE.md §19.38). */
export async function v1GateReason(
  database: DbOrTx,
  flags: Pick<MatchingFlagEnv, "MATCHING_V1_FORCE">,
): Promise<string | null> {
  if (flags.MATCHING_V1_FORCE) return null
  const completed = await countCompletedLaunches(database)
  if (completed >= MIN_COMPLETED_LAUNCHES_FOR_V1) return null
  return `Only ${completed} of the ${MIN_COMPLETED_LAUNCHES_FOR_V1} completed launches v1 needs exist, so v0 ranks.`
}

function toConfig(
  row: ConfigRow,
  requestedVersion: string,
  fallbackReason: string | null,
): ActiveMatchingConfig {
  return {
    modelVersion: row.modelVersion,
    kind: row.kind,
    ...parseRow(row),
    requestedVersion,
    fallbackReason,
  }
}

/**
 * The version that ranks right now: `MATCHING_MODEL_VERSION` when set, else the row marked active
 * (at most one, a unique partial index guarantees it). A logistic (v1) version ranks only once
 * ≥ 50 launches went live, or with `MATCHING_V1_FORCE` (refused in production by lib/env.ts);
 * otherwise, and when a pinned version does not exist, v0 ranks and `fallbackReason` says why.
 */
export async function loadActiveMatchingConfig(
  database: DbOrTx,
  options: { flags?: MatchingFlagEnv } = {},
): Promise<ActiveMatchingConfig> {
  const flags = options.flags ?? {
    MATCHING_MODEL_VERSION: env.MATCHING_MODEL_VERSION,
    MATCHING_V1_FORCE: env.MATCHING_V1_FORCE,
  }
  let requested: ConfigRow | null
  let requestedVersion: string
  let missingReason: string | null = null
  if (flags.MATCHING_MODEL_VERSION) {
    requestedVersion = flags.MATCHING_MODEL_VERSION
    requested = await loadRow(database, requestedVersion)
    if (!requested) {
      missingReason = `MATCHING_MODEL_VERSION names ${requestedVersion}, which does not exist, so v0 ranks.`
    }
  } else {
    const [row] = await database
      .select(configColumns)
      .from(matchingConfig)
      .where(eq(matchingConfig.active, true))
      .limit(1)
    requested = row ?? null
    requestedVersion = row?.modelVersion ?? V0_MODEL_VERSION
    if (!row) missingReason = "No model version is active, so v0 ranks."
  }

  if (requested && requested.kind !== "logistic") {
    return toConfig(requested, requestedVersion, null)
  }
  const gate = requested ? await v1GateReason(database, flags) : missingReason
  if (requested && !gate) return toConfig(requested, requestedVersion, null)

  const v0 = await loadRow(database, V0_MODEL_VERSION)
  if (!v0) throw new MatchingConfigError("No usable matching_config row (v0 is missing)")
  return toConfig(v0, requestedVersion, gate)
}
