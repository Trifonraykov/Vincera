import "server-only"

import { and, eq, isNull } from "drizzle-orm"
import { createElement } from "react"

import type { ClaudeDeps } from "@/lib/ai/claude"
import { now, runWithClock } from "@/lib/clock"
import { getDb, withTransaction, type DbOrTx } from "@/lib/db/client"
import { isPgError, PG_ERROR } from "@/lib/db/errors"
import { audienceSnapshots, socialConnections, type SizeTier } from "@/lib/db/schema"
import SocialExpiredEmail, { socialExpiredSubject } from "@/lib/email/templates/social-expired"
import { requestProfileEmbeddingRefresh } from "@/lib/embeddings/request"
import { env } from "@/lib/env"
import type { SocialExpiryReason } from "@/lib/events/types"
import { track } from "@/lib/events/track"
import { notify } from "@/lib/notifications/notify"
import { reportError } from "@/lib/observability"
import { absoluteUrl } from "@/lib/urls"

import { isSocialOAuthAvailable } from "./availability"
import { SOCIAL_PROVIDER_META } from "./catalog"
import { findConnection, tokenColumns, tokenSetOf, type SocialConnectionRow } from "./connections"
import { recomputeSizeTier, refreshAudienceSummary, type SummaryOutcome } from "./derived"
import {
  SocialProviderError,
  SocialRetryableError,
  socialErrorCode,
  type SocialErrorCode,
} from "./errors"
import { getProvider } from "./registry"
import { revalidatePublicProfiles } from "./revalidate"
import { tokenNeedsRefresh } from "./tokens"
import {
  audienceSnapshotInputSchema,
  SocialTokenError,
  type SocialProvider,
  type SocialProviderId,
  type TokenSet,
} from "./types"

/**
 * The single sync entrypoint (§7.1, §13 `social/sync`; CLAUDE.md §19.14). Used by the
 * `social/sync` job (on connect and from the daily fan-out) and by the resync buttons.
 *
 *   refresh the tokens when needed (lib/social/tokens.ts) → fetch the profile (display data) and
 *   the audience → write an `audience_snapshot` → recompute `size_tier` → emit `social.synced`
 *   → for creator providers: regenerate `audience_summary` + topics (never blocks) and request
 *   the creator profile's re-embedding (the debounced `embeddings-refresh` job, §19.25).
 *
 * A token failure (`SocialTokenError`) sets `status = expired`, emits `social.expired` and
 * notifies the user (in-app + email). Rate limits and outages record `last_sync_error` and come
 * back as `retryable` so the job retries; other provider failures are reported to Sentry.
 *
 * Every write is conditional on the token the sync started with (the access token ciphertext,
 * unique per encryption): when the user reconnects or disconnects while the provider is
 * answering, the sync's refreshed tokens, snapshot, errors and expiry are dropped instead of
 * overwriting the new connection (`skipped: superseded`).
 */

export type SyncOptions = {
  db?: DbOrTx
  /** Run with this clock (jobs under a mocked clock, tests). Defaults to lib/clock `now()`. */
  now?: Date
  /** Replace the provider (tests). Defaults to `getProvider(connection.provider)`. */
  provider?: SocialProvider
  ai?: ClaudeDeps
}

export type SyncResult =
  | {
      status: "synced"
      provider: SocialProviderId
      snapshotId: string
      followers: number | null
      sizeTier: SizeTier | null
      summary: SummaryOutcome | "not_applicable"
      /** `requested`: the embeddings job was asked to re-embed the creator profile. */
      embedding: "requested" | "not_applicable"
    }
  | {
      status: "skipped"
      /**
       * `superseded`: reconnected (new tokens) or disconnected while this sync ran.
       * `oauth_disabled`: the provider's OAuth is switched off (SOCIAL_OAUTH_DISABLED).
       */
      reason: "not_found" | "revoked" | "expired" | "manual" | "superseded" | "oauth_disabled"
    }
  | { status: "expired"; provider: SocialProviderId; reason: SocialExpiryReason }
  | { status: "failed"; provider: SocialProviderId; code: SocialErrorCode; retryable: boolean }

export async function syncConnection(
  connectionId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const run = () => syncNow(options.db ?? getDb(), connectionId, options)
  return options.now ? runWithClock(options.now, run) : run()
}

async function syncNow(
  database: DbOrTx,
  connectionId: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const row = await findConnection(database, connectionId)
  if (!row) return { status: "skipped", reason: "not_found" }
  if (row.source === "manual") return { status: "skipped", reason: "manual" }
  if (row.status === "revoked") return { status: "skipped", reason: "revoked" }
  if (row.status === "expired") return { status: "skipped", reason: "expired" }
  // The app may have no credentials now; the stored numbers stay as they are.
  if (!isSocialOAuthAvailable(row.provider)) return { status: "skipped", reason: "oauth_disabled" }

  // The token this sync works with; every write below requires it to still be the stored one.
  let tokenEnc = row.accessTokenEnc
  let tokens: TokenSet | null = tokenSetOf(row)
  if (!tokens || !tokenEnc) return markExpired(database, row, "unauthorized", tokenEnc)

  const provider = options.provider ?? getProvider(row.provider)
  let stage: "refresh" | "fetch" = "fetch"
  let written:
    { snapshotId: string; followers: number | null; sizeTier: SizeTier | null } | "superseded"
  try {
    if (tokenNeedsRefresh(row.provider, tokens, now())) {
      stage = "refresh"
      tokens = await provider.refresh(tokens)
      // Store at once: TikTok rotates refresh tokens, so losing this write loses the connection.
      const columns = tokenColumns(row.id, tokens)
      const stored = await database
        .update(socialConnections)
        .set(columns)
        .where(
          and(eq(socialConnections.id, row.id), eq(socialConnections.accessTokenEnc, tokenEnc)),
        )
        .returning({ id: socialConnections.id })
      if (stored.length === 0) return { status: "skipped", reason: "superseded" }
      tokenEnc = columns.accessTokenEnc
      stage = "fetch"
    }
    const profile = await provider.fetchProfile(tokens)
    const audience = audienceSnapshotInputSchema.parse(await provider.fetchAudience(tokens))
    const syncedTokenEnc = tokenEnc

    written = await withTransaction(async (tx) => {
      // Lock the row and check it still holds this sync's token (not reconnected meanwhile).
      const [current] = await tx
        .select({ tokenEnc: socialConnections.accessTokenEnc, status: socialConnections.status })
        .from(socialConnections)
        .where(eq(socialConnections.id, row.id))
        .for("update")
      if (!current || current.tokenEnc !== syncedTokenEnc || current.status !== "active") {
        return "superseded" as const
      }
      const takenAt = now()
      const [snapshot] = await tx
        .insert(audienceSnapshots)
        .values({ socialConnectionId: row.id, takenAt, ...audience })
        .returning({ id: audienceSnapshots.id })
      if (!snapshot) throw new Error("syncConnection: no snapshot row returned")
      await tx
        .update(socialConnections)
        .set({
          username: profile.username ?? row.username,
          displayName: profile.displayName ?? row.displayName,
          avatarUrl: profile.avatarUrl ?? row.avatarUrl,
          profileUrl: profile.profileUrl ?? row.profileUrl,
          lastSyncedAt: takenAt,
          lastSyncError: null,
          lastSyncErrorAt: null,
        })
        .where(eq(socialConnections.id, row.id))
      const tier = await recomputeSizeTier(tx, row.userId)
      await track(
        "social.synced",
        {
          actorUserId: null,
          subjectType: "social_connection",
          subjectId: row.id,
          properties: {
            provider: row.provider,
            snapshot_id: snapshot.id,
            followers: audience.followers,
            size_tier: tier.profileId ? tier.tier : null,
          },
        },
        tx,
      )
      return {
        snapshotId: snapshot.id,
        followers: audience.followers,
        sizeTier: tier.profileId ? tier.tier : null,
      }
    }, database)
  } catch (error) {
    if (error instanceof SocialTokenError) {
      const reason = stage === "refresh" ? "refresh_failed" : "unauthorized"
      return markExpired(database, row, reason, tokenEnc)
    }
    // Disconnected while the provider was answering: the snapshot has nowhere to go.
    if (isPgError(error, PG_ERROR.foreignKeyViolation)) {
      return { status: "skipped", reason: "not_found" }
    }
    if (!(error instanceof SocialRetryableError || error instanceof SocialProviderError)) {
      // Not a provider answer (a bug, the database, an invalid snapshot): let the job fail.
      throw error
    }
    const code = socialErrorCode(error)
    await recordSyncError(database, row.id, tokenEnc, code)
    const retryable = error instanceof SocialRetryableError
    if (!retryable) {
      reportError(error, { tags: { area: "social", provider: row.provider, code } })
    }
    return { status: "failed", provider: row.provider, code, retryable }
  }

  if (written === "superseded") return { status: "skipped", reason: "superseded" }

  // Creator audiences feed the profile's summary and embedding; GitHub (builders) does not.
  const isCreatorProvider = row.provider !== "github"
  let summary: SummaryOutcome | "not_applicable" = "not_applicable"
  let embedding: "requested" | "not_applicable" = "not_applicable"
  if (isCreatorProvider) {
    summary = (await refreshAudienceSummary(database, row.userId, { ai: options.ai })).outcome
    await requestProfileEmbeddingRefresh(row.userId, "creator", database)
    embedding = "requested"
  }
  await revalidatePublicProfiles(database, row.userId)

  return { status: "synced", provider: row.provider, ...written, summary, embedding }
}

/** Record a failed sync, unless the connection got other tokens meanwhile (a reconnect). */
async function recordSyncError(
  database: DbOrTx,
  connectionId: string,
  tokenEnc: string,
  code: SocialErrorCode,
): Promise<void> {
  await database
    .update(socialConnections)
    .set({ lastSyncError: code, lastSyncErrorAt: now() })
    .where(
      and(eq(socialConnections.id, connectionId), eq(socialConnections.accessTokenEnc, tokenEnc)),
    )
}

/**
 * The token is dead: mark the connection expired (once; concurrent syncs race on the status),
 * emit `social.expired`, recompute the size tier (an expired connection no longer counts as
 * verified) and notify the user in-app and by email (§7.1). Only while the connection still holds
 * the dead token (`tokenEnc`): a reconnect in the meantime stored a working one.
 */
async function markExpired(
  database: DbOrTx,
  row: SocialConnectionRow,
  reason: SocialExpiryReason,
  tokenEnc: string | null,
): Promise<SyncResult> {
  const expired = await withTransaction(async (tx) => {
    const at = now()
    const updated = await tx
      .update(socialConnections)
      .set({ status: "expired", lastSyncError: "token_expired", lastSyncErrorAt: at })
      .where(
        and(
          eq(socialConnections.id, row.id),
          eq(socialConnections.status, "active"),
          tokenEnc === null
            ? isNull(socialConnections.accessTokenEnc)
            : eq(socialConnections.accessTokenEnc, tokenEnc),
        ),
      )
      .returning({ id: socialConnections.id })
    if (updated.length === 0) return false

    await track(
      "social.expired",
      {
        actorUserId: null,
        subjectType: "social_connection",
        subjectId: row.id,
        properties: { provider: row.provider, reason },
      },
      tx,
    )
    await recomputeSizeTier(tx, row.userId)

    // Last, so the email goes out only once everything above succeeded (§19.11 notify).
    const label = SOCIAL_PROVIDER_META[row.provider].label
    await notify(
      {
        userId: row.userId,
        type: "social.expired",
        payload: { connection_id: row.id, provider: row.provider },
        // One per expiry of this token (a reconnect issues a new one).
        dedupeKey: `social.expired:${row.id}:${(row.tokenObtainedAt ?? row.createdAt).getTime()}`,
        email: {
          subject: socialExpiredSubject(label),
          react: createElement(SocialExpiredEmail, {
            appName: env.APP_NAME,
            provider: label,
            accountName: row.displayName ?? (row.username ? `@${row.username}` : null),
            reconnectUrl: absoluteUrl("/app/settings/connections"),
          }),
        },
      },
      tx,
    )
    return true
  }, database)
  if (!expired) {
    // Already expired by a concurrent sync, or reconnected / disconnected meanwhile.
    const current = await findConnection(database, row.id)
    if (current?.status !== "expired") return { status: "skipped", reason: "superseded" }
    return { status: "expired", provider: row.provider, reason }
  }
  await revalidatePublicProfiles(database, row.userId)
  return { status: "expired", provider: row.provider, reason }
}
