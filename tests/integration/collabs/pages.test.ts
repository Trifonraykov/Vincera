import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import CollabAgreementPage from "@/app/app/collabs/[id]/agreement/page"
import CollabLayout from "@/app/app/collabs/[id]/layout"
import CollabMessagesPage from "@/app/app/collabs/[id]/messages/page"
import CollabOverviewPage from "@/app/app/collabs/[id]/page"
import CollabTasksPage from "@/app/app/collabs/[id]/tasks/page"
import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { resetMemoryRateLimits } from "@/lib/ratelimit"

import { setupTestDatabase } from "../../helpers/db"
import { insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import { acceptedCollab, authUserOf, makeTempDataDir, removeTempDataDir } from "./helpers"

/**
 * The collab pages' own access check (§6: collab data is visible only to its members and admins;
 * §19.9: every page calls the rule itself). Each page loader runs with a mocked session: members
 * and admins get the page, anyone else (and a malformed or unknown id) a 404.
 */

const mocks = vi.hoisted(() => ({ dir: "", db: null as unknown, user: null as unknown }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/session")>()
  return { ...original, requireOnboardedUser: async () => mocks.user }
})

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")

beforeAll(async () => {
  mocks.dir = await makeTempDataDir()
})
afterAll(async () => {
  await removeTempDataDir(mocks.dir)
})
beforeEach(() => {
  mocks.db = testDb.db
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(() => setClockForTests(null))

const PAGES = [
  ["overview", CollabOverviewPage],
  ["agreement", CollabAgreementPage],
  ["tasks", CollabTasksPage],
  ["messages", CollabMessagesPage],
] as const

function render(page: (typeof PAGES)[number][1], user: AuthUser, id: string) {
  mocks.user = user
  return page({ params: Promise.resolve({ id }) })
}

/** Next's `notFound()` throws an error whose digest names the 404 fallback. */
async function expectNotFound(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    digest: expect.stringContaining("404"),
  })
}

describe("collab pages", () => {
  it("open for members and admins, and answer 404 to everyone else", async () => {
    const { creator, builder, collabId } = await acceptedCollab(testDb.db)
    const stranger = authUserOf(await insertUser(testDb.db, { onboardingCompletedAt: NOW }))
    const admin = authUserOf(
      await insertUser(testDb.db, {
        roles: ["admin"],
        activeRole: "admin",
        onboardingCompletedAt: NOW,
      }),
    )

    for (const [name, page] of PAGES) {
      for (const user of [creator.auth, builder.auth, admin]) {
        await expect(render(page, user, collabId), `${name} for ${user.id}`).resolves.toBeTruthy()
      }
      await expectNotFound(render(page, stranger, collabId))
      await expectNotFound(render(page, creator.auth, "not-a-uuid"))
      await expectNotFound(render(page, creator.auth, "0190a8a0-0000-7000-8000-000000000000"))
    }
  })

  it("are guarded by the [id] layout too, outside the loading boundary (a real 404 status)", async () => {
    const { creator, builder, collabId } = await acceptedCollab(testDb.db)
    const stranger = authUserOf(await insertUser(testDb.db, { onboardingCompletedAt: NOW }))
    const layout = (user: AuthUser, id: string) => {
      mocks.user = user
      return CollabLayout({ children: "ok", params: Promise.resolve({ id }) })
    }
    await expect(layout(creator.auth, collabId)).resolves.toBe("ok")
    await expect(layout(builder.auth, collabId)).resolves.toBe("ok")
    await expectNotFound(layout(stranger, collabId))
    await expectNotFound(layout(creator.auth, "not-a-uuid"))
    await expectNotFound(layout(creator.auth, "0190a8a0-0000-7000-8000-000000000000"))
  })
})
