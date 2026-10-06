import "server-only"

import { and, eq } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import type { AuthzUser } from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { adminAuditLog, audienceSnapshots, socialConnections } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { newId } from "@/lib/ids"
import { reportError } from "@/lib/observability"
import { storageKey } from "@/lib/storage/keys"
import { getStorage } from "@/lib/storage/r2"
import type { ObjectStorage } from "@/lib/storage/types"

import { canVerifySocialConnection } from "./authz"
import { SOCIAL_PROVIDER_META } from "./catalog"
import { recomputeSizeTier } from "./derived"
import {
  checkEvidenceFile,
  checkManualEntryFields,
  EVIDENCE_EXTENSIONS,
  EVIDENCE_POLICY,
} from "./manual-policy"
import { latestSnapshotsFor } from "./queries"
import type { CreatorSocialProviderId } from "./types"

/**
 * Manual entry fallback (§7.1, CLAUDE.md §19.14): follower count + profile link + screenshot,
 * stored as a `source = manual` connection (no tokens, `verified_at` null → "Unverified") with an
 * audience snapshot holding just the follower count. An admin verifies it after checking the
 * screenshot (`verifyManualConnection`, written to `admin_audit_log`).
 *
 * Screenshot upload: the browser checks the typed fields, asks for a signed PUT URL
 * (`createEvidenceUpload`), uploads the file directly to storage, then submits the form with the
 * object key. The key must be under the user's own prefix for that provider, and the object is
 * checked again (type, size) before it is accepted, because an R2 presigned PUT cannot enforce a
 * size limit (§19.7). A refused entry deletes the screenshot it uploaded, unless a connection
 * still points at it.
 */

const EVIDENCE_PREFIX = "social-evidence"
const UPLOAD_URL_TTL_SECONDS = 10 * 60
/** How long an admin's screenshot link stays valid. */
const EVIDENCE_VIEW_TTL_SECONDS = 5 * 60

/** `social-evidence/<userId>/<provider>-`: where that user's screenshots for that provider go. */
function evidencePrefix(userId: string, provider: CreatorSocialProviderId): string {
  return `${EVIDENCE_PREFIX}/${userId}/${provider}-`
}

export type EvidenceUpload = {
  key: string
  uploadUrl: string
  contentType: string
  maxBytes: number
}

/** A signed PUT URL for the screenshot of a manual entry. */
export async function createEvidenceUpload(
  input: {
    userId: string
    provider: CreatorSocialProviderId
    contentType: string
    sizeBytes: number
  },
  storage: ObjectStorage = getStorage(),
): Promise<EvidenceUpload> {
  const check = checkEvidenceFile(input)
  if (!check.ok) throw new ActionError(check.message)
  const extension = EVIDENCE_EXTENSIONS[check.contentType as keyof typeof EVIDENCE_EXTENSIONS]
  const key = storageKey(EVIDENCE_PREFIX, input.userId, `${input.provider}-${newId()}.${extension}`)
  const uploadUrl = await storage.signedPutUrl(key, {
    contentType: check.contentType,
    maxBytes: EVIDENCE_POLICY.maxBytes,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  })
  return { key, uploadUrl, contentType: check.contentType, maxBytes: EVIDENCE_POLICY.maxBytes }
}

export type ManualEntryInput = {
  userId: string
  provider: CreatorSocialProviderId
  /** As typed ("12,500") or a number; checked with `checkManualEntryFields`. */
  followers: number | string
  profileUrl: string
  evidenceKey: string
}

export type ManualEntryResult = {
  connectionId: string
  snapshotId: string
  created: boolean
  /**
   * The same entry was submitted again (same screenshot, count and link, e.g. a retried
   * request): nothing was written.
   */
  unchanged: boolean
  /** The previous screenshot, now replaced; deleted from storage by the caller. */
  replacedEvidenceKey: string | null
}

function screenshotError(message: string): ActionError {
  return new ActionError(message, { fieldErrors: { screenshot: [message] } })
}

/** Check the uploaded screenshot; anything unacceptable is refused (and deleted by the caller). */
async function assertEvidence(
  input: Pick<ManualEntryInput, "userId" | "provider" | "evidenceKey">,
  storage: ObjectStorage,
): Promise<void> {
  if (!input.evidenceKey.startsWith(evidencePrefix(input.userId, input.provider))) {
    throw screenshotError("Upload your screenshot again, then submit the form.")
  }
  const info = await storage.statObject(input.evidenceKey)
  if (!info) throw screenshotError("We didn't receive your screenshot. Please upload it again.")
  const check = checkEvidenceFile({ contentType: info.contentType, sizeBytes: info.sizeBytes })
  if (!check.ok) throw screenshotError(check.message)
}

/**
 * Delete a screenshot this user uploaded for `provider` that no connection points at: the
 * upload of a refused (or unchanged) entry. Keys outside the user's own prefix for the provider
 * are never touched. Best effort: failures are reported, never thrown.
 */
export async function discardUnusedEvidence(
  database: DbOrTx,
  input: Pick<ManualEntryInput, "userId" | "provider" | "evidenceKey">,
  storage: ObjectStorage = getStorage(),
): Promise<void> {
  if (!input.evidenceKey.startsWith(evidencePrefix(input.userId, input.provider))) return
  try {
    const [inUse] = await database
      .select({ id: socialConnections.id })
      .from(socialConnections)
      .where(eq(socialConnections.evidenceStorageKey, input.evidenceKey))
      .limit(1)
    if (!inUse) await storage.deleteObject(input.evidenceKey)
  } catch (error) {
    reportError(error, { tags: { area: "social", step: "discard_evidence" } })
  }
}

/**
 * Store (or update) a manual entry and its snapshot. Refused while an OAuth connection for the
 * provider exists: verified data always wins, so the user resyncs or reconnects instead. A
 * refusal deletes the uploaded screenshot (`discardUnusedEvidence`).
 */
export async function submitManualEntry(
  database: DbOrTx,
  input: ManualEntryInput,
  storage: ObjectStorage = getStorage(),
): Promise<ManualEntryResult> {
  try {
    const fields = checkManualEntryFields(input.provider, input)
    if (!fields.ok) {
      const message =
        fields.fieldErrors.profileUrl?.[0] ??
        fields.fieldErrors.followers?.[0] ??
        "Check the highlighted fields."
      throw new ActionError(message, { fieldErrors: fields.fieldErrors })
    }
    await assertEvidence(input, storage)
    return await storeManualEntry(database, { ...input, ...fields.data })
  } catch (error) {
    if (error instanceof ActionError) await discardUnusedEvidence(database, input, storage)
    throw error
  }
}

async function storeManualEntry(
  database: DbOrTx,
  input: ManualEntryInput & { followers: number },
): Promise<ManualEntryResult> {
  const label = SOCIAL_PROVIDER_META[input.provider].label
  return withTransaction(async (tx) => {
    const at = now()
    const [existing] = await tx
      .select()
      .from(socialConnections)
      .where(
        and(
          eq(socialConnections.userId, input.userId),
          eq(socialConnections.provider, input.provider),
        ),
      )
      .for("update")
    if (existing && existing.source === "oauth" && existing.status !== "revoked") {
      throw new ActionError(
        existing.status === "expired"
          ? `Your ${label} account is connected but its access expired. Reconnect it instead of entering numbers by hand.`
          : `Your ${label} account is already connected, so its numbers are verified. Use Resync to update them.`,
      )
    }
    if (existing && existing.evidenceStorageKey === input.evidenceKey) {
      // The screenshot this entry already stands on. The very same entry again is a no-op; new
      // numbers or a new link need a new screenshot (an admin may have checked the old one).
      const latest = (await latestSnapshotsFor(tx, [existing.id])).get(existing.id)
      if (
        latest &&
        latest.followers === input.followers &&
        existing.profileUrl === input.profileUrl
      ) {
        return {
          connectionId: existing.id,
          snapshotId: latest.id,
          created: false,
          unchanged: true,
          replacedEvidenceKey: null,
        }
      }
      throw screenshotError("Upload a new screenshot that shows this number.")
    }

    const values = {
      source: "manual" as const,
      status: "active" as const,
      profileUrl: input.profileUrl,
      evidenceStorageKey: input.evidenceKey,
      // New numbers need a new check.
      verifiedAt: null,
      lastSyncedAt: at,
      lastSyncError: null,
      lastSyncErrorAt: null,
      accessTokenEnc: null,
      refreshTokenEnc: null,
      expiresAt: null,
      refreshExpiresAt: null,
      tokenObtainedAt: null,
      scopes: [],
    }
    const [connection] = existing
      ? await tx
          .update(socialConnections)
          .set(values)
          .where(eq(socialConnections.id, existing.id))
          .returning()
      : await tx
          .insert(socialConnections)
          .values({
            userId: input.userId,
            provider: input.provider,
            providerAccountId: null,
            ...values,
          })
          .returning()
    if (!connection) throw new Error("submitManualEntry: no connection row returned")

    const [snapshot] = await tx
      .insert(audienceSnapshots)
      .values({
        socialConnectionId: connection.id,
        takenAt: at,
        followers: input.followers,
        avgViews: null,
        engagementRate: null,
        topCountries: [],
        countriesBasis: null,
        ageGender: null,
        topTopics: [],
        raw: { source: "manual", v: 1 },
      })
      .returning({ id: audienceSnapshots.id })
    if (!snapshot) throw new Error("submitManualEntry: no snapshot row returned")

    const tier = await recomputeSizeTier(tx, input.userId)
    if (!existing) {
      await track(
        "social.connected",
        {
          actorUserId: input.userId,
          subjectType: "social_connection",
          subjectId: connection.id,
          properties: { provider: input.provider, source: "manual" },
        },
        tx,
      )
    }
    await track(
      "social.synced",
      {
        actorUserId: input.userId,
        subjectType: "social_connection",
        subjectId: connection.id,
        properties: {
          provider: input.provider,
          snapshot_id: snapshot.id,
          followers: input.followers,
          size_tier: tier.profileId ? tier.tier : null,
        },
      },
      tx,
    )

    const previousKey = existing?.evidenceStorageKey ?? null
    return {
      connectionId: connection.id,
      snapshotId: snapshot.id,
      created: !existing,
      unchanged: false,
      replacedEvidenceKey: previousKey && previousKey !== input.evidenceKey ? previousKey : null,
    }
  }, database)
}

/** Best-effort removal of a screenshot that is no longer referenced. */
export async function deleteEvidenceObject(
  key: string | null,
  storage: ObjectStorage = getStorage(),
): Promise<void> {
  if (!key) return
  try {
    await storage.deleteObject(key)
  } catch (error) {
    reportError(error, { tags: { area: "social", step: "delete_evidence" } })
  }
}

export class ManualVerificationError extends ActionError {
  constructor(message: string) {
    super(message)
    this.name = "ManualVerificationError"
  }
}

/**
 * An admin confirms a manual entry after checking its screenshot and profile link (§7.1 "Admins
 * can verify manually", §14 "Every admin action is written to admin_audit_log"). Sets
 * `verified_at`, writes the audit row and recomputes the size tier, in one transaction.
 * Idempotent: verifying a verified entry changes nothing. Returns the owner's id so the caller
 * can refresh the audience summary (which labels unverified numbers).
 */
export async function verifyManualConnection(
  database: DbOrTx,
  adminUser: Pick<AuthzUser, "id" | "roles" | "status">,
  connectionId: string,
): Promise<{ userId: string; verifiedNow: boolean }> {
  if (!canVerifySocialConnection(adminUser)) {
    throw new ManualVerificationError("Only admins can verify manual entries.")
  }
  return withTransaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.id, connectionId))
      .for("update")
    if (!row) throw new ManualVerificationError("This connection no longer exists.")
    if (row.source !== "manual") {
      throw new ManualVerificationError("Only manual entries need verifying.")
    }
    if (row.verifiedAt) return { userId: row.userId, verifiedNow: false }

    const at = now()
    await tx
      .update(socialConnections)
      .set({ verifiedAt: at })
      .where(eq(socialConnections.id, row.id))
    await tx.insert(adminAuditLog).values({
      adminUserId: adminUser.id,
      action: "social_connection.verified",
      targetType: "social_connection",
      targetId: row.id,
      before: { verified_at: null },
      after: {
        verified_at: at.toISOString(),
        provider: row.provider,
        user_id: row.userId,
      },
    })
    await recomputeSizeTier(tx, row.userId)
    return { userId: row.userId, verifiedNow: true }
  }, database)
}

/** A short-lived link to a manual entry's screenshot, for the admin who verifies it. */
export async function evidenceViewUrl(
  database: DbOrTx,
  adminUser: Pick<AuthzUser, "roles" | "status">,
  connectionId: string,
  storage: ObjectStorage = getStorage(),
): Promise<string | null> {
  if (!canVerifySocialConnection(adminUser)) return null
  const [row] = await database
    .select({ key: socialConnections.evidenceStorageKey })
    .from(socialConnections)
    .where(eq(socialConnections.id, connectionId))
    .limit(1)
  if (!row?.key) return null
  return storage.signedGetUrl(row.key, { expiresInSeconds: EVIDENCE_VIEW_TTL_SECONDS })
}
