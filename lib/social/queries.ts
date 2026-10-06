import "server-only"

import { asc, desc, eq, getTableColumns, inArray } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { audienceSnapshots, socialConnections } from "@/lib/db/schema"

import { SOCIAL_PROVIDER_IDS, type SocialProviderId } from "./types"

/**
 * Read models for social connections and their snapshots (§5, §7.1). Token ciphertexts are never
 * selected here: pages and jobs that only display or aggregate data cannot leak them.
 */

export type SnapshotRow = typeof audienceSnapshots.$inferSelect

const {
  accessTokenEnc: _accessTokenEnc,
  refreshTokenEnc: _refreshTokenEnc,
  ...connectionInfoColumns
} = getTableColumns(socialConnections)

/** A `social_connections` row without its token ciphertexts. */
export type ConnectionInfo = Omit<
  typeof socialConnections.$inferSelect,
  "accessTokenEnc" | "refreshTokenEnc"
>

export type ConnectionWithSnapshot = {
  connection: ConnectionInfo
  /** The newest snapshot, or null before the first sync. */
  latest: SnapshotRow | null
}

/** The newest snapshot of each connection (one query, `DISTINCT ON`). */
export async function latestSnapshotsFor(
  database: DbOrTx,
  connectionIds: readonly string[],
): Promise<Map<string, SnapshotRow>> {
  if (connectionIds.length === 0) return new Map()
  const rows = await database
    .selectDistinctOn([audienceSnapshots.socialConnectionId])
    .from(audienceSnapshots)
    .where(inArray(audienceSnapshots.socialConnectionId, [...connectionIds]))
    .orderBy(
      asc(audienceSnapshots.socialConnectionId),
      desc(audienceSnapshots.takenAt),
      desc(audienceSnapshots.id),
    )
  return new Map(rows.map((row) => [row.socialConnectionId, row]))
}

/** Provider order on every page: YouTube first (recommended), GitHub last. */
const PROVIDER_ORDER = new Map<SocialProviderId, number>(
  SOCIAL_PROVIDER_IDS.map((provider, index) => [provider, index]),
)

/** The user's connections (any status) with their newest snapshots, in provider order. */
export async function listUserConnections(
  database: DbOrTx,
  userId: string,
): Promise<ConnectionWithSnapshot[]> {
  const connections = await database
    .select(connectionInfoColumns)
    .from(socialConnections)
    .where(eq(socialConnections.userId, userId))
  const latest = await latestSnapshotsFor(
    database,
    connections.map((connection) => connection.id),
  )
  return connections
    .map((connection) => ({ connection, latest: latest.get(connection.id) ?? null }))
    .sort(
      (a, b) =>
        (PROVIDER_ORDER.get(a.connection.provider) ?? 0) -
        (PROVIDER_ORDER.get(b.connection.provider) ?? 0),
    )
}

/** One connection without tokens, or null. */
export async function findConnectionInfo(
  database: DbOrTx,
  connectionId: string,
): Promise<ConnectionInfo | null> {
  const [row] = await database
    .select(connectionInfoColumns)
    .from(socialConnections)
    .where(eq(socialConnections.id, connectionId))
    .limit(1)
  return row ?? null
}
