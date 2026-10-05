import path from "node:path"

import { and, eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { findJob } from "@/inngest/functions"
import { dailySyncFanOut } from "@/inngest/functions/social-daily-sync"
import { setClockForTests } from "@/lib/clock"
import { allowGdprErasure } from "@/lib/db/append-only"
import { closeDb } from "@/lib/db/client"
import {
  adminAuditLog,
  audienceSnapshots,
  creatorProfiles,
  notifications,
  socialConnections,
} from "@/lib/db/schema"
import { listOutbox } from "@/lib/email/outbox"
import { SocialRetryableError } from "@/lib/social/errors"
import {
  createEvidenceUpload,
  submitManualEntry,
  verifyManualConnection,
} from "@/lib/social/manual"
import { getProvider } from "@/lib/social/registry"
import { purgeExpiredYouTubeSnapshots } from "@/lib/social/retention"
import { reviewAudienceSummary } from "@/lib/social/summary"
import { syncConnection } from "@/lib/social/sync"
import { SocialTokenError } from "@/lib/social/types"
import { createLocalStorage } from "@/lib/storage/local"

import { setupTestDatabase } from "../../helpers/db"
import { insertBuilder, insertSocialConnection, insertUser } from "../../helpers/db-fixtures"
import { stubSocialEnv } from "../../unit/social/helpers"
import {
  authUserOf,
  eventsOf,
  makeTempDataDir,
  newCreator,
  removeTempDataDir,
  runOAuthFlow,
} from "./helpers"

/**
 * The sync pipeline (§7.1 "Sync flow", §13 `social/sync`, CLAUDE.md §19.14) against the fake
 * providers and fake AI/embeddings: snapshot, size tier, AI summary, embedding and events; token
 * refresh; expiry (status, event, in-app + email notification); retention of YouTube data; the
 * manual-entry fallback and its admin verification; the creator's review of the summary; and the
 * registered jobs.
 */

const dataRoot = vi.hoisted(() => ({ dir: "" }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(dataRoot.dir, ...segments) }
})

const NOW = new Date("2026-10-05T12:00:00.000Z")
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const testDb = setupTestDatabase()

beforeEach(async () => {
  dataRoot.dir = await makeTempDataDir()
  stubSocialEnv()
  setClockForTests(NOW)
  await testDb.db.transaction(async (tx) => {
    await allowGdprErasure(tx)
    await tx.delete(socialConnections)
  })
})

afterEach(async () => {
  setClockForTests(null)
  await closeDb()
  await removeTempDataDir(dataRoot.dir)
})

async function connectYouTube(account = "ada-codes") {
  const creator = await newCreator(testDb.db)
  await runOAuthFlow(testDb.db, { user: creator.auth, provider: "youtube", account })
  const [connection] = await testDb.db
    .select()
    .from(socialConnections)
    .where(eq(socialConnections.userId, creator.user.id))
  if (!connection) throw new Error("not connected")
  return { ...creator, connection }
}

async function profileOf(userId: string) {
  const [profile] = await testDb.db
    .select()
    .from(creatorProfiles)
    .where(eq(creatorProfiles.userId, userId))
  return profile
}

async function snapshotsOf(connectionId: string) {
  return testDb.db
    .select()
    .from(audienceSnapshots)
    .where(eq(audienceSnapshots.socialConnectionId, connectionId))
}

async function connectionsOf(userId: string) {
  return testDb.db.select().from(socialConnections).where(eq(socialConnections.userId, userId))
}

describe("syncConnection", () => {
  it("writes a snapshot, size tier, AI summary, topics, embedding and events", async () => {
    const { connection, user } = await connectYouTube()
    const result = await syncConnection(connection.id, { db: testDb.db })
    expect(result).toMatchObject({
      status: "synced",
      provider: "youtube",
      sizeTier: "micro",
      summary: "generated",
      embedding: "updated",
    })
    if (result.status !== "synced") return

    const [snapshot, ...others] = await snapshotsOf(connection.id)
    expect(others).toEqual([])
    expect(snapshot).toMatchObject({
      id: result.snapshotId,
      takenAt: NOW,
      followers: 48_200,
      countriesBasis: "viewers",
    })
    expect(snapshot?.topCountries?.length).toBeGreaterThan(0)
    expect(snapshot?.ageGender?.basis).toBe("viewers")

    const profile = await profileOf(user.id)
    expect(profile).toMatchObject({
      sizeTier: "micro",
      audienceSummaryPromptVersion: "audience_summary@v1",
      audienceSummaryGeneratedAt: NOW,
      audienceSummaryEditedAt: null,
      embeddingModel: "fake:hashed-bow-1024",
    })
    expect(profile?.audienceSummary).toBeTruthy()
    expect(profile?.topics.length).toBeGreaterThan(0)
    expect(profile?.embedding).toHaveLength(1024)

    const [updated] = await testDb.db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.id, connection.id))
    expect(updated).toMatchObject({ lastSyncedAt: NOW, lastSyncError: null })

    expect(await eventsOf(testDb.db, "social.synced", connection.id)).toEqual([
      expect.objectContaining({
        actorUserId: null,
        properties: {
          provider: "youtube",
          snapshot_id: result.snapshotId,
          followers: 48_200,
          size_tier: "micro",
        },
      }),
    ])
    expect(await eventsOf(testDb.db, "ai.generated", profile?.id)).toEqual([
      expect.objectContaining({
        subjectType: "creator_profile",
        properties: expect.objectContaining({
          use: "audience_summary",
          prompt_version: "audience_summary@v1",
          accepted_by_user: null,
          fallback: false,
        }),
      }),
    ])
  })

  it("keeps a summary the creator edited", async () => {
    const { connection, user } = await connectYouTube()
    await testDb.db
      .update(creatorProfiles)
      .set({ audienceSummary: "My own words.", topics: ["mine"], audienceSummaryEditedAt: NOW })
      .where(eq(creatorProfiles.userId, user.id))
    const result = await syncConnection(connection.id, { db: testDb.db })
    expect(result).toMatchObject({ status: "synced", summary: "kept_edited" })
    expect(await profileOf(user.id)).toMatchObject({
      audienceSummary: "My own words.",
      topics: ["mine"],
      sizeTier: "micro",
    })
  })

  it("never blocks on the model: a failed generation keeps the old summary", async () => {
    const { connection, user } = await connectYouTube()
    await testDb.db
      .update(creatorProfiles)
      .set({ audienceSummary: "Earlier summary." })
      .where(eq(creatorProfiles.userId, user.id))
    const result = await syncConnection(connection.id, {
      db: testDb.db,
      ai: {
        transport: async () => {
          throw new Error("API down")
        },
      },
    })
    expect(result).toMatchObject({ status: "synced", summary: "fallback" })
    const profile = await profileOf(user.id)
    expect(profile?.audienceSummary).toBe("Earlier summary.")
    expect(await eventsOf(testDb.db, "ai.generated", profile?.id)).toEqual([
      expect.objectContaining({ properties: expect.objectContaining({ fallback: true }) }),
    ])
  })

  it("refreshes an expiring token before reading and stores the new one", async () => {
    const { connection } = await connectYouTube()
    const later = new Date(NOW.getTime() + 2 * HOUR)
    const result = await syncConnection(connection.id, { db: testDb.db, now: later })
    expect(result.status).toBe("synced")
    const [row] = await testDb.db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.id, connection.id))
    expect(row?.accessTokenEnc).not.toBe(connection.accessTokenEnc)
    expect(row?.tokenObtainedAt).toEqual(later)
    expect(row?.expiresAt?.getTime()).toBe(later.getTime() + 3599 * 1000)
    // Google's refresh reply has no refresh_token: the stored one is kept.
    expect(row?.refreshTokenEnc).toBeTruthy()
  })

  it("marks the connection expired on a token failure and notifies the user once", async () => {
    const { connection, user } = await connectYouTube("lapsed-lens")
    const later = new Date(NOW.getTime() + 2 * HOUR)
    const result = await syncConnection(connection.id, { db: testDb.db, now: later })
    expect(result).toEqual({ status: "expired", provider: "youtube", reason: "refresh_failed" })

    const [row] = await testDb.db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.id, connection.id))
    expect(row).toMatchObject({
      status: "expired",
      lastSyncError: "token_expired",
      lastSyncErrorAt: later,
    })
    expect(await snapshotsOf(connection.id)).toEqual([])
    expect(await eventsOf(testDb.db, "social.expired", connection.id)).toEqual([
      expect.objectContaining({ properties: { provider: "youtube", reason: "refresh_failed" } }),
    ])

    const inApp = await testDb.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user.id))
    expect(inApp).toEqual([
      expect.objectContaining({
        type: "social.expired",
        payload: { connection_id: connection.id, provider: "youtube" },
      }),
    ])
    const emails = (await listOutbox()).filter((email) => email.to.includes(user.email ?? "-"))
    expect(emails).toHaveLength(1)
    expect(emails[0]?.subject).toBe("Reconnect your YouTube account")
    expect(emails[0]?.text).toContain("/app/settings/connections")

    // Later syncs skip it until the user reconnects; no second notification.
    expect(await syncConnection(connection.id, { db: testDb.db, now: later })).toEqual({
      status: "skipped",
      reason: "expired",
    })
    expect(
      await testDb.db.select().from(notifications).where(eq(notifications.userId, user.id)),
    ).toHaveLength(1)
  })

  it("records a rate limit as last_sync_error and reports it as retryable", async () => {
    const { connection } = await connectYouTube()
    const real = getProvider("youtube")
    const result = await syncConnection(connection.id, {
      db: testDb.db,
      provider: {
        ...real,
        authUrl: real.authUrl.bind(real),
        exchangeCode: real.exchangeCode.bind(real),
        refresh: real.refresh.bind(real),
        fetchProfile: real.fetchProfile.bind(real),
        fetchAudience: async () => {
          throw new SocialRetryableError("youtube", "rate_limited", "youtube quota")
        },
      },
    })
    expect(result).toEqual({
      status: "failed",
      provider: "youtube",
      code: "rate_limited",
      retryable: true,
    })
    const [row] = await testDb.db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.id, connection.id))
    expect(row).toMatchObject({ status: "active", lastSyncError: "rate_limited" })
    expect(await snapshotsOf(connection.id)).toEqual([])
  })

  it("drops a sync whose connection was reconnected meanwhile", async () => {
    const { connection, user, auth } = await connectYouTube()
    const real = getProvider("youtube")
    const result = await syncConnection(connection.id, {
      db: testDb.db,
      provider: {
        ...real,
        authUrl: real.authUrl.bind(real),
        exchangeCode: real.exchangeCode.bind(real),
        refresh: real.refresh.bind(real),
        fetchProfile: real.fetchProfile.bind(real),
        fetchAudience: async (tokens) => {
          const audience = await real.fetchAudience(tokens)
          // The creator connects another channel while YouTube is answering.
          await runOAuthFlow(testDb.db, {
            user: auth,
            provider: "youtube",
            account: "quiet-kitchen",
          })
          return audience
        },
      },
    })
    expect(result).toEqual({ status: "skipped", reason: "superseded" })
    // The old channel's numbers never land on the new connection.
    expect(await snapshotsOf(connection.id)).toEqual([])
    expect(await eventsOf(testDb.db, "social.synced", connection.id)).toEqual([])
    const [row] = await connectionsOf(user.id)
    expect(row).toMatchObject({ status: "active", lastSyncedAt: null, username: "@quietkitchen" })
  })

  it("never expires a connection that was reconnected while its old token failed", async () => {
    const { connection, user, auth } = await connectYouTube()
    const real = getProvider("youtube")
    const result = await syncConnection(connection.id, {
      db: testDb.db,
      provider: {
        ...real,
        authUrl: real.authUrl.bind(real),
        exchangeCode: real.exchangeCode.bind(real),
        refresh: real.refresh.bind(real),
        fetchProfile: real.fetchProfile.bind(real),
        fetchAudience: async () => {
          await runOAuthFlow(testDb.db, { user: auth, provider: "youtube", account: "ada-codes" })
          throw new SocialTokenError("youtube", "revoked")
        },
      },
    })
    expect(result).toEqual({ status: "skipped", reason: "superseded" })
    const [row] = await connectionsOf(user.id)
    expect(row).toMatchObject({ status: "active", lastSyncError: null })
    expect(await eventsOf(testDb.db, "social.expired", connection.id)).toEqual([])
    expect(
      await testDb.db.select().from(notifications).where(eq(notifications.userId, user.id)),
    ).toEqual([])
  })

  it("syncs a builder's GitHub account without touching creator fields", async () => {
    const builder = await insertBuilder(testDb.db)
    await runOAuthFlow(testDb.db, {
      user: authUserOf(builder.user),
      provider: "github",
      account: "octo-builder",
    })
    const [connection] = await testDb.db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.userId, builder.user.id))
    const result = await syncConnection(connection!.id, { db: testDb.db })
    expect(result).toMatchObject({
      status: "synced",
      provider: "github",
      sizeTier: null,
      summary: "not_applicable",
      embedding: "not_applicable",
    })
    const [snapshot] = await snapshotsOf(connection!.id)
    expect(snapshot?.raw).toMatchObject({ provider: "github", v: 1 })
  })

  it("skips manual entries and unknown connections", async () => {
    const user = await insertUser(testDb.db)
    const manual = await insertSocialConnection(testDb.db, user.id, { source: "manual" })
    expect(await syncConnection(manual.id, { db: testDb.db })).toEqual({
      status: "skipped",
      reason: "manual",
    })
    expect(await syncConnection(crypto.randomUUID(), { db: testDb.db })).toEqual({
      status: "skipped",
      reason: "not_found",
    })
  })
})

describe("jobs", () => {
  it("registers social/sync, the daily fan-out and YouTube retention", () => {
    expect(findJob("social-sync")?.event).toBe("social/sync.requested")
    expect(findJob("social-daily-sync")).toMatchObject({
      event: "social/daily-sync.requested",
      cron: { schedule: expect.any(String), data: {} },
    })
    expect(findJob("social-youtube-retention")).toMatchObject({
      event: "social/youtube-retention.requested",
      cron: { schedule: expect.any(String), data: {} },
    })
  })

  it("the daily fan-out syncs every active OAuth connection not synced in 20 hours", async () => {
    stubSocialEnv({ DATABASE_URL: testDb.url })
    await closeDb()
    const fresh = await connectYouTube("ada-codes")
    const stale = await connectYouTube("quiet-kitchen")
    const manual = await insertSocialConnection(testDb.db, stale.user.id, {
      provider: "instagram",
      source: "manual",
    })
    await testDb.db
      .update(socialConnections)
      .set({ lastSyncedAt: new Date(NOW.getTime() - 2 * HOUR) })
      .where(eq(socialConnections.id, fresh.connection.id))

    const result = await findJob("social-daily-sync")?.runInline({})
    expect(result).toEqual({ due: 1, failed: 0 })
    expect(await snapshotsOf(stale.connection.id)).toHaveLength(1)
    expect(await snapshotsOf(fresh.connection.id)).toEqual([])
    expect(await snapshotsOf(manual.id)).toEqual([])
  })

  it("under Inngest, sends the due connections page by page, one batch per step", async () => {
    stubSocialEnv({ DATABASE_URL: testDb.url })
    await closeDb()
    const due = [
      await connectYouTube("ada-codes"),
      await connectYouTube("quiet-kitchen"),
      await connectYouTube("lapsed-lens"),
    ]
      .map(({ connection }) => connection.id)
      .sort()
    const steps: string[] = []
    const batches: { ids: readonly string[]; day: string }[] = []

    const result = await dailySyncFanOut({
      mode: "inngest",
      pageSize: 2,
      step: {
        run: async (id, fn) => {
          steps.push(id)
          return fn()
        },
      },
      send: async (ids, day) => {
        batches.push({ ids, day })
      },
    })
    expect(result).toEqual({ due: 3, failed: 0 })
    expect(steps).toEqual(["sync-window", "enqueue-page-0", "enqueue-page-1"])
    expect(batches).toEqual([
      { ids: due.slice(0, 2), day: "2026-10-05" },
      { ids: due.slice(2), day: "2026-10-05" },
    ])
    // Nothing ran inline: the syncs are Inngest's runs.
    for (const id of due) expect(await snapshotsOf(id)).toEqual([])
  })
})

describe("YouTube retention", () => {
  async function snapshot(connectionId: string, daysAgo: number, followers: number) {
    await testDb.db.insert(audienceSnapshots).values({
      socialConnectionId: connectionId,
      takenAt: new Date(NOW.getTime() - daysAgo * DAY),
      followers,
      topCountries: [],
      topTopics: [],
      raw: {},
    })
  }

  it("deletes YouTube snapshots older than 30 days but keeps each connection's newest", async () => {
    const user = await insertUser(testDb.db)
    const other = await insertUser(testDb.db)
    const youtube = await insertSocialConnection(testDb.db, user.id, { provider: "youtube" })
    const lapsed = await insertSocialConnection(testDb.db, other.id, { provider: "youtube" })
    const instagram = await insertSocialConnection(testDb.db, user.id, { provider: "instagram" })
    await snapshot(youtube.id, 40, 1)
    await snapshot(youtube.id, 35, 2)
    await snapshot(youtube.id, 10, 3)
    await snapshot(lapsed.id, 60, 4)
    await snapshot(lapsed.id, 50, 5)
    await snapshot(instagram.id, 90, 6)

    expect(await purgeExpiredYouTubeSnapshots(testDb.db, { longRetention: true })).toEqual({
      skipped: true,
      reason: "long_retention_enabled",
    })
    expect(await snapshotsOf(youtube.id)).toHaveLength(3)

    const result = await purgeExpiredYouTubeSnapshots(testDb.db, { longRetention: false })
    expect(result).toEqual({
      skipped: false,
      cutoff: new Date(NOW.getTime() - 30 * DAY).toISOString(),
      deleted: 3,
    })
    expect((await snapshotsOf(youtube.id)).map((row) => row.followers)).toEqual([3])
    expect((await snapshotsOf(lapsed.id)).map((row) => row.followers)).toEqual([5])
    expect((await snapshotsOf(instagram.id)).map((row) => row.followers)).toEqual([6])

    // Idempotent.
    expect(await purgeExpiredYouTubeSnapshots(testDb.db, { longRetention: false })).toMatchObject({
      deleted: 0,
    })
  })

  it("follows YOUTUBE_LONG_RETENTION through the job", async () => {
    stubSocialEnv({ DATABASE_URL: testDb.url, YOUTUBE_LONG_RETENTION: "true" })
    await closeDb()
    expect(await findJob("social-youtube-retention")?.runInline({})).toEqual({
      skipped: true,
      reason: "long_retention_enabled",
    })
    stubSocialEnv({ DATABASE_URL: testDb.url, YOUTUBE_LONG_RETENTION: "false" })
    await closeDb()
    expect(await findJob("social-youtube-retention")?.runInline({})).toMatchObject({
      skipped: false,
    })
  })
})

describe("manual entry fallback", () => {
  const storage = () => createLocalStorage(path.join(dataRoot.dir, "storage"))

  async function uploadEvidence(userId: string, contentType = "image/png") {
    const store = storage()
    const upload = await createEvidenceUpload(
      { userId, provider: "instagram", contentType: "image/png", sizeBytes: 2048 },
      store,
    )
    // What the browser's PUT to the signed URL stores.
    await store.putObject(upload.key, new Uint8Array(2048), contentType)
    return upload
  }

  it("stores an unverified manual connection with a snapshot and an unverified tier", async () => {
    const creator = await newCreator(testDb.db)
    const upload = await uploadEvidence(creator.user.id)
    expect(upload.key.startsWith(`social-evidence/${creator.user.id}/instagram-`)).toBe(true)
    expect(upload.maxBytes).toBe(25 * 1024 * 1024)

    const result = await submitManualEntry(
      testDb.db,
      {
        userId: creator.user.id,
        provider: "instagram",
        followers: 12_500,
        profileUrl: "https://www.instagram.com/luna",
        evidenceKey: upload.key,
      },
      storage(),
    )
    expect(result.created).toBe(true)
    const [row] = await testDb.db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.id, result.connectionId))
    expect(row).toMatchObject({
      source: "manual",
      status: "active",
      verifiedAt: null,
      accessTokenEnc: null,
      refreshTokenEnc: null,
      providerAccountId: null,
      evidenceStorageKey: upload.key,
      profileUrl: "https://www.instagram.com/luna",
    })
    expect(await snapshotsOf(result.connectionId)).toEqual([
      expect.objectContaining({ followers: 12_500, ageGender: null, countriesBasis: null }),
    ])
    expect((await profileOf(creator.user.id))?.sizeTier).toBe("micro")
    expect(await eventsOf(testDb.db, "social.connected", result.connectionId)).toEqual([
      expect.objectContaining({ properties: { provider: "instagram", source: "manual" } }),
    ])
  })

  it("prefers verified connections for the size tier over bigger self-reported numbers", async () => {
    const { connection, user } = await connectYouTube()
    await syncConnection(connection.id, { db: testDb.db })
    const store = storage()
    const upload = await createEvidenceUpload(
      { userId: user.id, provider: "tiktok", contentType: "image/jpeg", sizeBytes: 100 },
      store,
    )
    await store.putObject(upload.key, new Uint8Array(100), "image/jpeg")
    await submitManualEntry(
      testDb.db,
      {
        userId: user.id,
        provider: "tiktok",
        followers: 900_000,
        profileUrl: "https://www.tiktok.com/@big",
        evidenceKey: upload.key,
      },
      store,
    )
    // 900K self-reported would be macro; the verified 48.2K YouTube channel wins.
    expect((await profileOf(user.id))?.sizeTier).toBe("micro")
  })

  it("refuses screenshots outside the user's prefix, wrong types and OAuth-connected providers", async () => {
    const creator = await newCreator(testDb.db)
    const other = await insertUser(testDb.db)
    const foreign = await uploadEvidence(other.id)
    await expect(
      submitManualEntry(
        testDb.db,
        {
          userId: creator.user.id,
          provider: "instagram",
          followers: 10,
          profileUrl: "https://www.instagram.com/x",
          evidenceKey: foreign.key,
        },
        storage(),
      ),
    ).rejects.toThrow("Upload your screenshot again")
    // Someone else's screenshot is never deleted on their behalf.
    expect(await storage().statObject(foreign.key)).not.toBeNull()

    const pdf = await uploadEvidence(creator.user.id, "application/pdf")
    await expect(
      submitManualEntry(
        testDb.db,
        {
          userId: creator.user.id,
          provider: "instagram",
          followers: 10,
          profileUrl: "https://www.instagram.com/x",
          evidenceKey: pdf.key,
        },
        storage(),
      ),
    ).rejects.toThrow("PNG, JPEG, WebP or GIF")
    expect(await storage().statObject(pdf.key)).toBeNull()

    await expect(
      submitManualEntry(
        testDb.db,
        {
          userId: creator.user.id,
          provider: "instagram",
          followers: 10,
          profileUrl: "https://evil.example/instagram",
          evidenceKey: pdf.key,
        },
        storage(),
      ),
    ).rejects.toThrow("https:// link to your Instagram profile")

    const { user } = await connectYouTube()
    const store = storage()
    const upload = await createEvidenceUpload(
      { userId: user.id, provider: "youtube", contentType: "image/png", sizeBytes: 10 },
      store,
    )
    await store.putObject(upload.key, new Uint8Array(10), "image/png")
    await expect(
      submitManualEntry(
        testDb.db,
        {
          userId: user.id,
          provider: "youtube",
          followers: 10,
          profileUrl: "https://www.youtube.com/@x",
          evidenceKey: upload.key,
        },
        store,
      ),
    ).rejects.toThrow("already connected")
    // The refused entry's upload is gone.
    expect(await store.statObject(upload.key)).toBeNull()
  })

  it("checks the typed fields on the server, deleting the upload of a refused entry", async () => {
    const creator = await newCreator(testDb.db)
    const upload = await uploadEvidence(creator.user.id)
    const refused = submitManualEntry(
      testDb.db,
      {
        userId: creator.user.id,
        provider: "instagram",
        followers: "",
        profileUrl: "https://www.instagram.com/luna",
        evidenceKey: upload.key,
      },
      storage(),
    )
    await expect(refused).rejects.toMatchObject({
      fieldErrors: { followers: ["Enter your follower count as a whole number."] },
    })
    expect(await storage().statObject(upload.key)).toBeNull()
    expect(await connectionsOf(creator.user.id)).toEqual([])
  })

  it("refuses a screenshot uploaded for another provider", async () => {
    const creator = await newCreator(testDb.db)
    const instagram = await uploadEvidence(creator.user.id)
    await expect(
      submitManualEntry(
        testDb.db,
        {
          userId: creator.user.id,
          provider: "tiktok",
          followers: 10,
          profileUrl: "https://www.tiktok.com/@luna",
          evidenceKey: instagram.key,
        },
        storage(),
      ),
    ).rejects.toThrow("Upload your screenshot again")
  })

  it("treats the same entry again as a no-op, and refuses new numbers on the old screenshot", async () => {
    const creator = await newCreator(testDb.db)
    const upload = await uploadEvidence(creator.user.id)
    const entry = {
      userId: creator.user.id,
      provider: "instagram" as const,
      followers: "12,500",
      profileUrl: "https://www.instagram.com/luna",
      evidenceKey: upload.key,
    }
    const first = await submitManualEntry(testDb.db, entry, storage())
    const adminRow = await insertUser(testDb.db, { roles: ["admin"] })
    await verifyManualConnection(testDb.db, authUserOf(adminRow), first.connectionId)

    // A retried request: nothing changes, the admin's check stands.
    const again = await submitManualEntry(testDb.db, entry, storage())
    expect(again).toMatchObject({
      connectionId: first.connectionId,
      snapshotId: first.snapshotId,
      unchanged: true,
      replacedEvidenceKey: null,
    })
    expect(await snapshotsOf(first.connectionId)).toHaveLength(1)
    const [row] = await connectionsOf(creator.user.id)
    expect(row?.verifiedAt).toEqual(NOW)

    // Other numbers need a new screenshot; the one on file is kept.
    await expect(
      submitManualEntry(testDb.db, { ...entry, followers: 90_000 }, storage()),
    ).rejects.toThrow("Upload a new screenshot")
    expect(await storage().statObject(upload.key)).not.toBeNull()
    expect(await snapshotsOf(first.connectionId)).toHaveLength(1)

    // A new screenshot replaces the old one and needs a new check.
    const next = await uploadEvidence(creator.user.id)
    const updated = await submitManualEntry(
      testDb.db,
      { ...entry, followers: 90_000, evidenceKey: next.key },
      storage(),
    )
    expect(updated).toMatchObject({ unchanged: false, replacedEvidenceKey: upload.key })
    const [after] = await connectionsOf(creator.user.id)
    expect(after).toMatchObject({ verifiedAt: null, evidenceStorageKey: next.key })
  })

  it("an admin verifies a manual entry (audited); the tier becomes verified", async () => {
    const creator = await newCreator(testDb.db)
    const upload = await uploadEvidence(creator.user.id)
    const { connectionId } = await submitManualEntry(
      testDb.db,
      {
        userId: creator.user.id,
        provider: "instagram",
        followers: 250_000,
        profileUrl: "https://www.instagram.com/luna",
        evidenceKey: upload.key,
      },
      storage(),
    )
    const adminRow = await insertUser(testDb.db, { roles: ["admin"] })
    const admin = authUserOf(adminRow)

    await expect(verifyManualConnection(testDb.db, creator.auth, connectionId)).rejects.toThrow(
      "Only admins",
    )
    expect(await verifyManualConnection(testDb.db, admin, connectionId)).toEqual({
      userId: creator.user.id,
      verifiedNow: true,
    })
    expect(await verifyManualConnection(testDb.db, admin, connectionId)).toEqual({
      userId: creator.user.id,
      verifiedNow: false,
    })

    const [row] = await testDb.db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.id, connectionId))
    expect(row?.verifiedAt).toEqual(NOW)
    expect((await profileOf(creator.user.id))?.sizeTier).toBe("mid")
    const audit = await testDb.db
      .select()
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.targetId, connectionId), eq(adminAuditLog.adminUserId, admin.id)))
    expect(audit).toEqual([
      expect.objectContaining({
        action: "social_connection.verified",
        targetType: "social_connection",
        before: { verified_at: null },
        after: expect.objectContaining({ verified_at: NOW.toISOString(), provider: "instagram" }),
      }),
    ])
  })
})

describe("reviewing the audience summary", () => {
  it("records acceptance of the AI text, and edits with edited_at", async () => {
    const { connection, user } = await connectYouTube()
    await syncConnection(connection.id, { db: testDb.db })
    const before = await profileOf(user.id)

    const accepted = await reviewAudienceSummary(testDb.db, {
      userId: user.id,
      form: { summary: before?.audienceSummary ?? "", topics: before?.topics ?? [] },
      source: "onboarding",
    })
    expect(accepted).toMatchObject({ changed: false, fields: [] })
    expect((await profileOf(user.id))?.audienceSummaryEditedAt).toBeNull()
    // Saving the same text again (e.g. later on /app/audience) is not a second decision.
    await reviewAudienceSummary(testDb.db, {
      userId: user.id,
      form: { summary: before?.audienceSummary ?? "", topics: before?.topics ?? [] },
      source: "settings",
    })
    expect(await eventsOf(testDb.db, "ai.reviewed", before?.id)).toHaveLength(1)

    // A new generation can be reviewed again.
    setClockForTests(new Date(NOW.getTime() + HOUR))
    await syncConnection(connection.id, { db: testDb.db })
    const edited = await reviewAudienceSummary(testDb.db, {
      userId: user.id,
      form: { summary: "Home cooks on a budget.", topics: ["budget cooking"] },
      source: "onboarding",
    })
    expect(edited).toMatchObject({ changed: true, fields: ["audience_summary", "topics"] })
    expect(await profileOf(user.id)).toMatchObject({
      audienceSummary: "Home cooks on a budget.",
      topics: ["budget cooking"],
      audienceSummaryEditedAt: new Date(NOW.getTime() + HOUR),
    })
    // Further edits of the creator's own text are not decisions on AI text.
    await reviewAudienceSummary(testDb.db, {
      userId: user.id,
      form: { summary: "Home cooks on a tight budget.", topics: ["budget cooking"] },
      source: "settings",
    })

    const reviews = await eventsOf(testDb.db, "ai.reviewed", before?.id)
    expect(reviews.map((event) => event.properties)).toEqual([
      {
        use: "audience_summary",
        prompt_version: "audience_summary@v1",
        accepted: true,
        edited: false,
      },
      {
        use: "audience_summary",
        prompt_version: "audience_summary@v1",
        accepted: false,
        edited: true,
      },
    ])
    expect(await eventsOf(testDb.db, "creator_profile.updated", before?.id)).toEqual([
      expect.objectContaining({
        properties: { fields: ["audience_summary", "topics"], source: "onboarding" },
      }),
      expect.objectContaining({
        properties: { fields: ["audience_summary"], source: "settings" },
      }),
    ])
  })
})
