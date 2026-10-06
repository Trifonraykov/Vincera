import path from "node:path"

import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { allowGdprErasure } from "@/lib/db/append-only"
import { closeDb } from "@/lib/db/client"
import { creatorProfiles, socialConnections } from "@/lib/db/schema"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { createLocalStorage } from "@/lib/storage/local"

import { setupTestDatabase } from "../../helpers/db"
import { stubSocialEnv } from "../../unit/social/helpers"
import { eventsOf, makeTempDataDir, newCreator, removeTempDataDir, runOAuthFlow } from "./helpers"

/**
 * The social server actions (lib/social/actions.ts) end to end with a mocked session: the
 * manual-entry submit (rate limit, server-side field checks, cleanup of refused uploads) and the
 * creator's saves of the audience summary (one `ai.reviewed` per generation).
 */

const mocks = vi.hoisted(() => ({
  user: null as AuthUser | null,
  db: null as unknown,
  dataDir: "",
}))

vi.mock("@/lib/auth/session", () => ({
  requireUser: async () => {
    if (!mocks.user) throw new Error("no user")
    return mocks.user
  },
}))
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dataDir, ...segments) }
})
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const { requestEvidenceUpload, submitManualConnection, updateAudienceSummary } =
  await import("@/lib/social/actions")
const { syncConnection } = await import("@/lib/social/sync")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")

beforeAll(async () => {
  // One directory for the file: the fake storage is created once per process.
  mocks.dataDir = await makeTempDataDir()
})
afterAll(async () => {
  await removeTempDataDir(mocks.dataDir)
})

beforeEach(async () => {
  stubSocialEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
  mocks.db = testDb.db
  mocks.user = null
  await testDb.db.transaction(async (tx) => {
    await allowGdprErasure(tx)
    await tx.delete(socialConnections)
  })
})
afterEach(async () => {
  setClockForTests(null)
  await closeDb()
})

const storage = () => createLocalStorage(path.join(mocks.dataDir, "storage"))

/** What the dialog does before submitting: ask for an upload URL and PUT the screenshot. */
async function uploadScreenshot(provider: "instagram" | "tiktok" = "instagram"): Promise<string> {
  const upload = await requestEvidenceUpload({ provider, contentType: "image/png", sizeBytes: 512 })
  if (!upload.ok) throw new Error(upload.error)
  await storage().putObject(upload.data.key, new Uint8Array(512), "image/png")
  return upload.data.key
}

describe("submitManualConnection", () => {
  it("stores the entry, and refuses invalid fields with field errors, deleting the upload", async () => {
    const creator = await newCreator(testDb.db)
    mocks.user = creator.auth

    const badKey = await uploadScreenshot()
    const refused = await submitManualConnection({
      provider: "instagram",
      followers: "lots",
      profileUrl: "https://example.com/luna",
      evidenceKey: badKey,
    })
    expect(refused).toEqual({
      ok: false,
      error: expect.any(String),
      fieldErrors: {
        followers: ["Enter your follower count as a whole number."],
        profileUrl: ["Enter the https:// link to your Instagram profile."],
      },
    })
    expect(await storage().statObject(badKey)).toBeNull()

    const key = await uploadScreenshot()
    const saved = await submitManualConnection({
      provider: "instagram",
      followers: "12,500",
      profileUrl: "https://www.instagram.com/luna",
      evidenceKey: key,
    })
    expect(saved).toMatchObject({ ok: true, data: { created: true } })
    const [row] = await testDb.db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.userId, creator.user.id))
    expect(row).toMatchObject({ source: "manual", evidenceStorageKey: key, verifiedAt: null })
  })

  it("is rate limited per user; a refused submit deletes its upload", async () => {
    const creator = await newCreator(testDb.db)
    mocks.user = creator.auth
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const key = await uploadScreenshot()
      const result = await submitManualConnection({
        provider: "instagram",
        followers: String(10_000 + attempt),
        profileUrl: "https://www.instagram.com/luna",
        evidenceKey: key,
      })
      expect(result.ok).toBe(true)
    }
    // Upload URLs have their own limit (10 per hour), so this one is put in place directly.
    const key = `social-evidence/${creator.user.id}/instagram-${crypto.randomUUID()}.png`
    await storage().putObject(key, new Uint8Array(512), "image/png")
    const limited = await submitManualConnection({
      provider: "instagram",
      followers: "20,000",
      profileUrl: "https://www.instagram.com/luna",
      evidenceKey: key,
    })
    expect(limited).toEqual({ ok: false, error: expect.stringContaining("try again later") })
    expect(await storage().statObject(key)).toBeNull()
  })
})

describe("updateAudienceSummary", () => {
  it("records the creator's decision on the AI text once per generation", async () => {
    const creator = await newCreator(testDb.db)
    mocks.user = creator.auth
    await runOAuthFlow(testDb.db, {
      user: creator.auth,
      provider: "youtube",
      account: "ada-codes",
    })
    const [connection] = await testDb.db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.userId, creator.user.id))
    if (!connection) throw new Error("not connected")
    await syncConnection(connection.id, { db: testDb.db })
    const generated = await eventsOf(testDb.db, "ai.generated", creator.profile.id)
    expect(generated).toHaveLength(1)

    const [profile] = await testDb.db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.id, creator.profile.id))
    expect(profile?.audienceSummary).toBeTruthy()
    const form = {
      summary: profile?.audienceSummary ?? "",
      topics: profile?.topics.join(", ") ?? "",
    }
    expect(await updateAudienceSummary(form)).toEqual({ ok: true, data: { changed: false } })
    expect(await updateAudienceSummary(form)).toEqual({ ok: true, data: { changed: false } })

    const reviewed = await eventsOf(testDb.db, "ai.reviewed", creator.profile.id)
    expect(reviewed.map((event) => event.properties)).toEqual([
      {
        use: "audience_summary",
        prompt_version: "audience_summary@v1",
        accepted: true,
        edited: false,
      },
    ])
  })
})
