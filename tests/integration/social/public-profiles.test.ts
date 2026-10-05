import path from "node:path"

import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { portfolioItems, socialConnections, users } from "@/lib/db/schema"
import { loadPublicBuilderProfile, loadPublicCreatorProfile } from "@/lib/public-profiles/load"
import { createEvidenceUpload, submitManualEntry } from "@/lib/social/manual"
import { syncConnection } from "@/lib/social/sync"
import { createLocalStorage } from "@/lib/storage/local"

import { setupTestDatabase } from "../../helpers/db"
import { insertBuilder } from "../../helpers/db-fixtures"
import { stubSocialEnv } from "../../unit/social/helpers"
import { authUserOf, makeTempDataDir, newCreator, removeTempDataDir, runOAuthFlow } from "./helpers"

/**
 * Public profiles expose only public fields (§6; CLAUDE.md §19.14): verified badges and aggregate
 * counts, never emails, tokens, demographics breakdowns, screenshots or unverified links; unknown
 * and suspended users are not found.
 */

const dataRoot = vi.hoisted(() => ({ dir: "" }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(dataRoot.dir, ...segments) }
})

const NOW = new Date("2026-10-05T12:00:00.000Z")
const testDb = setupTestDatabase()

beforeEach(async () => {
  dataRoot.dir = await makeTempDataDir()
  stubSocialEnv()
  setClockForTests(NOW)
})

afterEach(async () => {
  setClockForTests(null)
  await removeTempDataDir(dataRoot.dir)
})

describe("/c/[handle]", () => {
  it("shows verified and unverified platforms with aggregate numbers only", async () => {
    const creator = await newCreator(testDb.db)
    await runOAuthFlow(testDb.db, { user: creator.auth, provider: "youtube", account: "ada-codes" })
    const [youtube] = await testDb.db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.userId, creator.user.id))
    await syncConnection(youtube!.id, { db: testDb.db })

    const storage = createLocalStorage(path.join(dataRoot.dir, "storage"))
    const upload = await createEvidenceUpload(
      { userId: creator.user.id, provider: "instagram", contentType: "image/png", sizeBytes: 10 },
      storage,
    )
    await storage.putObject(upload.key, new Uint8Array(10), "image/png")
    await submitManualEntry(
      testDb.db,
      {
        userId: creator.user.id,
        provider: "instagram",
        followers: 3_000,
        profileUrl: "https://www.instagram.com/someone-else",
        evidenceKey: upload.key,
      },
      storage,
    )

    const profile = await loadPublicCreatorProfile(testDb.db, creator.profile.handle)
    expect(profile).toMatchObject({
      handle: creator.profile.handle,
      displayName: creator.profile.displayName,
      sizeTier: "micro",
      sizeTierVerified: true,
      verifiedReach: 48_200,
    })
    expect(profile?.audienceSummary).toBeTruthy()
    expect(profile?.platforms).toEqual([
      expect.objectContaining({
        provider: "youtube",
        verified: true,
        followers: 48_200,
        profileUrl: expect.stringMatching(/^https:\/\//),
      }),
      expect.objectContaining({
        provider: "instagram",
        verified: false,
        followers: 3_000,
        // Unverified links are never shown.
        profileUrl: null,
      }),
    ])

    const serialized = JSON.stringify(profile)
    expect(serialized).not.toContain(creator.user.email ?? "@")
    expect(serialized).not.toContain(creator.user.id)
    expect(serialized).not.toContain("v1:")
    expect(serialized).not.toContain("social-evidence")
    expect(serialized).not.toContain("ageGender")
    expect(serialized).not.toContain("topCountries")
  })

  it("is not found for unknown handles, invalid handles and suspended users", async () => {
    const creator = await newCreator(testDb.db)
    expect(await loadPublicCreatorProfile(testDb.db, "nobody_here")).toBeNull()
    expect(await loadPublicCreatorProfile(testDb.db, "Bad Handle!")).toBeNull()
    expect(await loadPublicCreatorProfile(testDb.db, creator.profile.handle)).not.toBeNull()
    await testDb.db.update(users).set({ status: "suspended" }).where(eq(users.id, creator.user.id))
    expect(await loadPublicCreatorProfile(testDb.db, creator.profile.handle)).toBeNull()
  })
})

describe("/b/[handle]", () => {
  it("shows skills, portfolio (safe links only) and GitHub stats", async () => {
    const builder = await insertBuilder(testDb.db)
    await testDb.db.insert(portfolioItems).values([
      {
        builderProfileId: builder.profile.id,
        title: "Invoice CLI",
        url: "https://example.test/cli",
        isShipped: true,
      },
      { builderProfileId: builder.profile.id, title: "Sketchy", url: "javascript:alert(1)" },
    ])
    await runOAuthFlow(testDb.db, {
      user: authUserOf(builder.user),
      provider: "github",
      account: "octo-builder",
    })
    const [github] = await testDb.db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.userId, builder.user.id))
    await syncConnection(github!.id, { db: testDb.db })

    const profile = await loadPublicBuilderProfile(testDb.db, builder.profile.handle)
    expect(profile).toMatchObject({
      handle: builder.profile.handle,
      availability: "open",
      dealPreference: "either",
      portfolio: [
        expect.objectContaining({ title: "Invoice CLI", url: "https://example.test/cli" }),
        expect.objectContaining({ title: "Sketchy", url: null }),
      ],
      github: expect.objectContaining({ current: true, login: expect.any(String) }),
    })
    expect(profile?.github?.stats?.totalStars).toBeGreaterThan(0)
    expect(profile?.github?.stats?.topLanguages.length).toBeGreaterThan(0)
    expect(JSON.stringify(profile)).not.toContain(builder.user.email ?? "@")

    expect(await loadPublicBuilderProfile(testDb.db, "missing_builder")).toBeNull()
  })
})
