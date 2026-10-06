import "server-only"

import { and, eq, ne } from "drizzle-orm"

import { now } from "@/lib/clock"
import { decrypt, DecryptionError, encrypt } from "@/lib/crypto"
import { allowGdprErasure } from "@/lib/db/append-only"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { isPgError, PG_ERROR } from "@/lib/db/errors"
import { audienceSnapshots, socialConnections } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { newId } from "@/lib/ids"

import { recomputeSizeTier } from "./derived"
import type { SocialProfile, SocialProviderId, TokenSet } from "./types"

/**
 * `social_connections` writes for the connection flow (§7.1, CLAUDE.md §19.11, §19.14):
 * encrypted token storage, the OAuth upsert (one connection per user and provider; reconnecting
 * updates it), and disconnecting (tokens and snapshots deleted, §14).
 */

export type SocialConnectionRow = typeof socialConnections.$inferSelect

/** A connection failure the user can act on (`?error=<code>` on the page that started it). */
export class SocialConnectError extends Error {
  constructor(readonly code: "account_in_use") {
    super(`Social connection refused: ${code}`)
    this.name = "SocialConnectError"
  }
}

// --- Tokens ------------------------------------------------------------------------------------

/** AAD binding a token ciphertext to its row and column, so it cannot be copied elsewhere. */
function tokenAad(connectionId: string, kind: "access" | "refresh"): string {
  return `social_connections.${kind}_token:${connectionId}`
}

/** The token columns of a connection row for `tokens` (ciphertexts from lib/crypto.ts, §4). */
export function tokenColumns(connectionId: string, tokens: TokenSet) {
  return {
    accessTokenEnc: encrypt(tokens.accessToken, { aad: tokenAad(connectionId, "access") }),
    refreshTokenEnc: tokens.refreshToken
      ? encrypt(tokens.refreshToken, { aad: tokenAad(connectionId, "refresh") })
      : null,
    expiresAt: tokens.expiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    tokenObtainedAt: tokens.obtainedAt ?? null,
    scopes: [...tokens.scopes],
  }
}

/**
 * The stored tokens of a connection, decrypted. Null for manual rows (no tokens) and when the
 * ciphertext cannot be decrypted (e.g. a rotated key): the caller treats that as expired.
 */
export function tokenSetOf(
  row: Pick<
    SocialConnectionRow,
    | "id"
    | "accessTokenEnc"
    | "refreshTokenEnc"
    | "expiresAt"
    | "refreshExpiresAt"
    | "tokenObtainedAt"
    | "scopes"
    | "providerAccountId"
  >,
): TokenSet | null {
  if (!row.accessTokenEnc) return null
  try {
    return {
      accessToken: decrypt(row.accessTokenEnc, { aad: tokenAad(row.id, "access") }),
      refreshToken: row.refreshTokenEnc
        ? decrypt(row.refreshTokenEnc, { aad: tokenAad(row.id, "refresh") })
        : null,
      expiresAt: row.expiresAt,
      refreshExpiresAt: row.refreshExpiresAt,
      scopes: row.scopes,
      providerAccountId: row.providerAccountId,
      obtainedAt: row.tokenObtainedAt,
    }
  } catch (error) {
    if (error instanceof DecryptionError) return null
    throw error
  }
}

// --- Reads -------------------------------------------------------------------------------------

export async function findConnection(
  database: DbOrTx,
  connectionId: string,
): Promise<SocialConnectionRow | null> {
  const [row] = await database
    .select()
    .from(socialConnections)
    .where(eq(socialConnections.id, connectionId))
    .limit(1)
  return row ?? null
}

export async function findUserConnection(
  database: DbOrTx,
  userId: string,
  provider: SocialProviderId,
): Promise<SocialConnectionRow | null> {
  const [row] = await database
    .select()
    .from(socialConnections)
    .where(and(eq(socialConnections.userId, userId), eq(socialConnections.provider, provider)))
    .limit(1)
  return row ?? null
}

// --- Connect (OAuth) ---------------------------------------------------------------------------

export type UpsertOAuthConnectionInput = {
  userId: string
  provider: SocialProviderId
  tokens: TokenSet
  /** From `provider.fetchProfile(tokens)`: its `providerAccountId` is the connection identity. */
  profile: SocialProfile
}

export type UpsertOAuthConnectionResult = {
  connection: SocialConnectionRow
  /** False when an existing row (reconnect, or a manual entry upgraded to OAuth) was updated. */
  created: boolean
  /**
   * True when the row now points at a different provider account than before: its old snapshots
   * (of the other account) were deleted.
   */
  accountChanged: boolean
  /**
   * True when the row's old snapshots were deleted: an account change, or a manual entry upgraded
   * to OAuth (self-reported numbers must not read as verified).
   */
  snapshotsDropped: boolean
  /** Evidence screenshot of the manual entry this replaced; delete it from storage. */
  replacedEvidenceKey: string | null
}

/**
 * Store a successful OAuth connection: one row per (user, provider), so a reconnect, or a manual
 * entry upgraded to OAuth, updates the existing row. Tokens are encrypted; the connection is
 * active and verified (the provider proved ownership, §19.11); `social.connected` is emitted in
 * the same transaction. Throws `SocialConnectError("account_in_use")` when the provider account
 * belongs to another user.
 */
export async function upsertOAuthConnection(
  database: DbOrTx,
  input: UpsertOAuthConnectionInput,
): Promise<UpsertOAuthConnectionResult> {
  const accountId = input.profile.providerAccountId
  try {
    return await withTransaction(async (tx) => {
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

      const [owner] = await tx
        .select({ id: socialConnections.id })
        .from(socialConnections)
        .where(
          and(
            eq(socialConnections.provider, input.provider),
            eq(socialConnections.providerAccountId, accountId),
            ne(socialConnections.userId, input.userId),
          ),
        )
        .limit(1)
      if (owner) throw new SocialConnectError("account_in_use")

      const id = existing?.id ?? newId()
      const accountChanged =
        existing !== undefined &&
        existing.providerAccountId !== null &&
        existing.providerAccountId !== accountId
      // A manual entry upgraded to OAuth: its snapshots hold the number the creator typed. Kept,
      // they would read as platform-verified as soon as this row is (latest snapshot + verified
      // connection), on /app/audience, in the size tier and on /c/<handle>, until the first
      // OAuth sync replaced them. They go like an account change's; the card shows "syncing"
      // until real numbers arrive.
      const upgradedFromManual = existing?.source === "manual"
      const dropSnapshots = accountChanged || upgradedFromManual
      const values = {
        providerAccountId: accountId,
        username: input.profile.username,
        displayName: input.profile.displayName,
        avatarUrl: input.profile.avatarUrl,
        profileUrl: input.profile.profileUrl,
        ...tokenColumns(id, { ...input.tokens, obtainedAt: input.tokens.obtainedAt ?? at }),
        status: "active" as const,
        source: "oauth" as const,
        verifiedAt: at,
        evidenceStorageKey: null,
        lastSyncError: null,
        lastSyncErrorAt: null,
      }

      let connection: SocialConnectionRow | undefined
      if (existing) {
        if (dropSnapshots) {
          // A different channel/account now: the old account's snapshots describe someone else's
          // audience, so they go like on a disconnect (§14). Same for self-reported numbers.
          await allowGdprErasure(tx)
          await tx.delete(audienceSnapshots).where(eq(audienceSnapshots.socialConnectionId, id))
        }
        ;[connection] = await tx
          .update(socialConnections)
          .set({ ...values, ...(dropSnapshots ? { lastSyncedAt: null } : {}) })
          .where(eq(socialConnections.id, id))
          .returning()
      } else {
        ;[connection] = await tx
          .insert(socialConnections)
          .values({ id, userId: input.userId, provider: input.provider, ...values })
          .returning()
      }
      if (!connection) throw new Error("upsertOAuthConnection: no row returned")

      await track(
        "social.connected",
        {
          actorUserId: input.userId,
          subjectType: "social_connection",
          subjectId: connection.id,
          properties: { provider: input.provider, source: "oauth" },
        },
        tx,
      )
      // The connection is verified (again) and may have lost its snapshots: the tier follows in
      // the same transaction, so nothing reads a tier built on numbers that are gone.
      await recomputeSizeTier(tx, input.userId)

      return {
        connection,
        created: existing === undefined,
        accountChanged,
        snapshotsDropped: dropSnapshots,
        replacedEvidenceKey: existing?.evidenceStorageKey ?? null,
      }
    }, database)
  } catch (error) {
    // Two users finishing the same account at once: the unique index decides.
    if (isPgError(error, PG_ERROR.uniqueViolation, "social_connections_provider_account_key")) {
      throw new SocialConnectError("account_in_use")
    }
    throw error
  }
}

// --- Disconnect --------------------------------------------------------------------------------

export type DisconnectedConnection = {
  id: string
  provider: SocialProviderId
  source: SocialConnectionRow["source"]
  /** The tokens that were stored, for a best-effort revoke after the commit. */
  tokens: TokenSet | null
  evidenceKey: string | null
}

/**
 * Disconnect: delete the user's connection row in one transaction that first allows GDPR erasure,
 * so its audience snapshots cascade with it and its tokens are gone (§14, §19.11), and emit
 * `social.disconnected`. `afterDelete` runs in the same transaction (e.g. recomputing the size
 * tier). Null when the user has no such connection.
 */
export async function disconnectConnection(
  database: DbOrTx,
  input: {
    connectionId: string
    userId: string
    afterDelete?: (tx: DbOrTx) => Promise<void>
  },
): Promise<DisconnectedConnection | null> {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(socialConnections)
      .where(
        and(
          eq(socialConnections.id, input.connectionId),
          eq(socialConnections.userId, input.userId),
        ),
      )
      .for("update")
    if (!row) return null

    const tokens = tokenSetOf(row)
    await allowGdprErasure(tx)
    await tx.delete(socialConnections).where(eq(socialConnections.id, row.id))
    await track(
      "social.disconnected",
      {
        actorUserId: input.userId,
        subjectType: "social_connection",
        subjectId: row.id,
        properties: { provider: row.provider, source: row.source },
      },
      tx,
    )
    await input.afterDelete?.(tx)
    return {
      id: row.id,
      provider: row.provider,
      source: row.source,
      tokens,
      evidenceKey: row.evidenceStorageKey,
    }
  }, database)
}
