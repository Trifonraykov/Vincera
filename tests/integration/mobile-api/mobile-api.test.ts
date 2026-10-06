import { and, eq } from "drizzle-orm"
import NextAuth from "next-auth"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { createAuthConfig } from "@/lib/auth/config"
import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import {
  agreements,
  collabs,
  events,
  matches,
  mobileSessions,
  proposals,
  sessions,
  users,
} from "@/lib/db/schema"
import { getEnv } from "@/lib/env"
import type { AuthHandlers } from "@/lib/mobile-api/auth"
import { mobileEndpoints } from "@/lib/mobile-api/endpoints"
import { handleMobileRequest } from "@/lib/mobile-api/router"
import { MOBILE_API_PREFIX } from "@/lib/mobile-api/schemas"
import { createMobileSession, hashMobileToken } from "@/lib/mobile-api/sessions"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { countSessions, deleteAllSessions } from "@/lib/users/account"

import { setupTestDatabase } from "../../helpers/db"
import { insertMatch, insertStripeAccount, insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import {
  eventsOf,
  makeTempDataDir,
  onboardedBuilder,
  onboardedCreator,
  openIdea,
  removeTempDataDir,
  seekingProduct,
} from "../proposals/helpers"

/**
 * The native app's API (CLAUDE.md §19.44) end to end against a test database: sign-in with the
 * emailed code (through the real Auth.js handlers, only the email transport captured), bearer
 * sessions, and a representative set of endpoints that wrap the web's services, with the same
 * events and the same authorization refusals.
 */

const mocks = vi.hoisted(() => ({
  dir: "",
  db: null as unknown,
  sent: [] as { to: string; url: string; code?: string }[],
}))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
vi.mock("@/lib/email/magic-link", () => ({
  sendMagicLinkEmail: async (input: { to: string; url: string; code?: string }) => {
    mocks.sent.push(input)
    return { id: "test" }
  },
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")

let endpoints: ReturnType<typeof mobileEndpoints>

beforeAll(async () => {
  mocks.dir = await makeTempDataDir()
})
afterAll(async () => {
  await removeTempDataDir(mocks.dir)
})
beforeEach(() => {
  mocks.db = testDb.db
  mocks.sent.length = 0
  stubServiceEnv({ FAKE_SERVICES: "all", ADMIN_EMAILS: "boss@example.test" })
  setClockForTests(NOW)
  resetMemoryRateLimits()
  const authHandlers = async (): Promise<AuthHandlers> =>
    NextAuth((request) => createAuthConfig(request, { db: testDb.db, env: getEnv() })).handlers
  endpoints = mobileEndpoints({ authHandlers })
})
afterEach(async () => {
  setClockForTests(null)
  await closeDb()
})

type Call = {
  status: number
  body: Record<string, unknown> & {
    error?: { code: string; message: string; fieldErrors?: Record<string, string[]> }
  }
}

async function api(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; ip?: string } = {},
): Promise<Call> {
  const headers = new Headers({ "x-forwarded-for": options.ip ?? "203.0.113.7" })
  if (options.token) headers.set("authorization", `Bearer ${options.token}`)
  if (options.body !== undefined) headers.set("content-type", "application/json")
  const response = await handleMobileRequest(
    new Request(`http://localhost:3000${MOBILE_API_PREFIX}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    endpoints,
    { db: testDb.db },
  )
  return { status: response.status, body: (await response.json()) as Call["body"] }
}

async function tokenFor(userId: string): Promise<string> {
  return (await createMobileSession(testDb.db, { userId, deviceName: "Test iPhone" })).token
}

function lastCode(): string {
  const code = mocks.sent.at(-1)?.code
  if (!code) throw new Error("no sign-in email sent")
  return code
}

describe("sign-in with the emailed code", () => {
  it("signs up a new person, returns a bearer token, and signs out", async () => {
    expect(await api("POST", "/auth/code", { body: { email: "Ada@Example.test" } })).toEqual({
      status: 200,
      body: { sent: true },
    })
    expect(mocks.sent).toHaveLength(1)
    expect(mocks.sent[0]?.to).toBe("ada@example.test")
    const code = lastCode()

    // A wrong code is refused and consumes nothing.
    const wrong = await api("POST", "/auth/verify", {
      body: { email: "ada@example.test", code: "ZZZZ-ZZZZ" },
    })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error?.fieldErrors?.code).toBeDefined()

    // Typed in lower case with a dash, as people do.
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase()
    const verified = await api("POST", "/auth/verify", {
      body: { email: "ADA@example.test", code: typed, deviceName: "Ada's iPhone", name: "Ada" },
    })
    expect(verified.status).toBe(200)
    const token = verified.body.token as string
    expect(token).toMatch(/^vmb_/)
    expect(verified.body.me).toMatchObject({
      email: "ada@example.test",
      name: "Ada",
      roles: [],
      onboarded: false,
      onboardingUrl: "http://localhost:3000/onboarding/role",
    })

    // A sign-up through the app is a sign-up like any other (§11); only the hash is stored.
    const [user] = await testDb.db.select().from(users).where(eq(users.email, "ada@example.test"))
    if (!user) throw new Error("no user")
    expect(await eventsOf(testDb.db, user.id, "user.signed_up")).toHaveLength(1)
    const [stored] = await testDb.db.select().from(mobileSessions)
    expect(stored).toMatchObject({ tokenHash: hashMobileToken(token), deviceName: "Ada's iPhone" })
    expect(JSON.stringify(stored)).not.toContain(token)
    // No web session (cookie) was created by the app's sign-in.
    expect(await testDb.db.select().from(sessions)).toHaveLength(0)

    // The code works once.
    expect(
      (await api("POST", "/auth/verify", { body: { email: "ada@example.test", code } })).status,
    ).toBe(400)

    expect((await api("GET", "/me", { token })).status).toBe(200)
    // Onboarding is finished on the web; app pages answer 403 until then.
    expect(await api("GET", "/home", { token })).toMatchObject({
      status: 403,
      body: { error: { code: "onboarding_required" } },
    })

    expect(await api("POST", "/auth/sign-out", { token })).toEqual({
      status: 200,
      body: { signedOut: true },
    })
    expect(await api("GET", "/me", { token })).toMatchObject({
      status: 401,
      body: { error: { code: "unauthorized" } },
    })
  })

  it("signs an existing person in and counts the phone among their sessions", async () => {
    const creator = await onboardedCreator(testDb.db)
    await api("POST", "/auth/code", { body: { email: creator.user.email } })
    const verified = await api("POST", "/auth/verify", {
      body: { email: creator.user.email, code: lastCode() },
    })
    expect(verified.status).toBe(200)
    expect(verified.body.me).toMatchObject({ id: creator.user.id, onboarded: true })
    expect(await eventsOf(testDb.db, creator.user.id, "user.signed_up")).toHaveLength(0)

    // Settings → Account's "Sign out everywhere" signs the phone out too.
    expect(await countSessions(testDb.db, creator.user.id)).toBe(1)
    await deleteAllSessions(testDb.db, creator.user.id)
    expect((await api("GET", "/me", { token: verified.body.token as string })).status).toBe(401)
  })

  it("applies the web's sign-in limits and refuses suspended accounts", async () => {
    // Code attempts: 10 per 10 minutes per email (the `email-callback` limit, §19.19).
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await api("POST", "/auth/verify", {
        body: { email: "guess@example.test", code: "AAAA-AAAA" },
        ip: `198.51.100.${attempt}`,
      })
      expect(result.status).toBe(400)
    }
    expect(
      await api("POST", "/auth/verify", {
        body: { email: "guess@example.test", code: "AAAA-AAAA" },
        ip: "198.51.100.200",
      }),
    ).toMatchObject({ status: 429, body: { error: { code: "rate_limited" } } })

    // Code requests: the §14 `auth` limit, 10 per 10 minutes per IP (Auth.js's signIn callback).
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(
        (await api("POST", "/auth/code", { body: { email: `p${attempt}@example.test` } })).status,
      ).toBe(200)
    }
    expect(await api("POST", "/auth/code", { body: { email: "p10@example.test" } })).toMatchObject({
      status: 429,
    })

    const suspended = await insertUser(testDb.db, { status: "suspended" })
    expect(
      await api("POST", "/auth/code", { body: { email: suspended.email }, ip: "192.0.2.50" }),
    ).toMatchObject({ status: 403, body: { error: { code: "suspended" } } })

    // A suspended account's existing app session stops working too.
    const token = await tokenFor(suspended.id)
    expect(await api("GET", "/me", { token })).toMatchObject({ status: 403 })
    // Malformed input is a 400 with field errors.
    expect(
      await api("POST", "/auth/code", { body: { email: "not-an-email" }, ip: "192.0.2.51" }),
    ).toMatchObject({ status: 400, body: { error: { code: "invalid_input" } } })
  })

  it("refuses requests without a valid token", async () => {
    expect(await api("GET", "/home")).toMatchObject({ status: 401 })
    expect(await api("GET", "/home", { token: "vmb_" + "x".repeat(43) })).toMatchObject({
      status: 401,
    })
    expect((await api("GET", "/no-such-endpoint")).status).toBe(404)
    expect((await api("DELETE", "/home")).status).toBe(405)
  })
})

describe("endpoints wrap the web's services", () => {
  it("negotiates, signs and works on a collab through the API", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const stranger = await onboardedBuilder(testDb.db)
    const idea = await openIdea(testDb.db, creator)
    const creatorToken = await tokenFor(creator.user.id)
    const builderToken = await tokenFor(builder.user.id)
    const strangerToken = await tokenFor(stranger.user.id)

    // The builder opens the idea and proposes.
    const detail = await api("GET", `/ideas/${idea.id}`, { token: builderToken })
    expect(detail).toMatchObject({ status: 200, body: { isOwner: false, canPropose: true } })

    const badSplit = await api("POST", "/proposals", {
      token: builderToken,
      body: {
        to: creator.user.id,
        targetKind: "idea",
        targetId: idea.id,
        scope: "A budgeting app.",
        creatorSplitPct: "60",
        builderSplitPct: "50",
        timelineWeeks: "6",
      },
    })
    expect(badSplit.status).toBe(400)
    expect(badSplit.body.error?.fieldErrors?.creatorSplitPct).toEqual([
      "The creator's and builder's shares must add up to 100%.",
    ])

    const sent = await api("POST", "/proposals", {
      token: builderToken,
      body: {
        to: creator.user.id,
        targetKind: "idea",
        targetId: idea.id,
        scope: "A budgeting app with CSV import.",
        message: "Hi!",
        creatorSplitPct: 60,
        builderSplitPct: 40,
        timelineWeeks: 6,
      },
    })
    expect(sent).toMatchObject({ status: 200, body: { status: "pending" } })
    const proposalId = sent.body.proposalId as string
    expect(await eventsOf(testDb.db, proposalId, "proposal.sent")).toHaveLength(1)

    // Same plain-language refusals as the web: the sender cannot answer their own offer.
    const [row] = await testDb.db.select().from(proposals).where(eq(proposals.id, proposalId))
    const revisionId = row?.currentRevisionId ?? ""
    expect(
      await api("POST", `/proposals/${proposalId}/accept`, {
        token: builderToken,
        body: { revisionId },
      }),
    ).toMatchObject({ status: 422, body: { error: { code: "refused" } } })
    // A stranger learns nothing about the proposal.
    expect((await api("GET", `/proposals/${proposalId}`, { token: strangerToken })).status).toBe(
      404,
    )
    expect(
      (
        await api("POST", `/proposals/${proposalId}/decline`, {
          token: strangerToken,
          body: { revisionId },
        })
      ).status,
    ).toBe(404)

    // The creator sees it waiting on Home and in the list, then counters.
    const home = await api("GET", "/home", { token: creatorToken })
    expect(home.status).toBe(200)
    expect(home.body.proposalsAwaiting).toHaveLength(1)
    const list = await api("GET", "/proposals?tab=received", { token: creatorToken })
    expect(list.body).toMatchObject({ counts: { received: 1, yourTurn: 1 }, nextCursor: null })
    const view = await api("GET", `/proposals/${proposalId}`, { token: creatorToken })
    expect(view.body).toMatchObject({
      actions: ["accept", "counter", "decline"],
      awaitingUserId: creator.user.id,
    })
    const countered = await api("POST", `/proposals/${proposalId}/counter`, {
      token: creatorToken,
      body: {
        revisionId,
        scope: "A budgeting app with CSV import and goals.",
        creatorSplitPct: "70",
        builderSplitPct: "30",
        timelineWeeks: "8",
      },
    })
    expect(countered).toMatchObject({ status: 200, body: { status: "countered" } })
    expect(await eventsOf(testDb.db, proposalId, "proposal.countered")).toHaveLength(1)

    // The builder accepts the counter-offer: a collab with its agreement.
    const builderView = await api("GET", `/proposals/${proposalId}`, { token: builderToken })
    const accepted = await api("POST", `/proposals/${proposalId}/accept`, {
      token: builderToken,
      body: { revisionId: builderView.body.currentRevisionId },
    })
    expect(accepted).toMatchObject({ status: 200, body: { status: "accepted" } })
    const collabId = accepted.body.collabId as string
    expect(await eventsOf(testDb.db, collabId, "collab.created")).toHaveLength(1)

    const collab = await api("GET", `/collabs/${collabId}`, { token: creatorToken })
    expect(collab.body).toMatchObject({
      stage: "agreement",
      scope: "A budgeting app with CSV import and goals.",
      nextStep: { text: "Sign the agreement", needsViewer: true },
    })
    expect((await api("GET", `/collabs/${collabId}`, { token: strangerToken })).status).toBe(404)
    expect((await api("GET", `/collabs/${collabId}/tasks`, { token: strangerToken })).status).toBe(
      404,
    )

    // Signing needs both members payouts-ready (§12), with the web's message.
    const before = await api("GET", `/collabs/${collabId}/agreement`, { token: creatorToken })
    const agreement = before.body.agreement as { id: string; bodyHash: string; canSign: boolean }
    expect(agreement.canSign).toBe(false)
    const refused = await api("POST", `/agreements/${agreement.id}/sign`, {
      token: creatorToken,
      body: { typedName: "Casey Creator", bodyHash: agreement.bodyHash },
    })
    expect(refused).toMatchObject({ status: 422, body: { error: { code: "refused" } } })
    expect(
      (
        await api("POST", `/agreements/${agreement.id}/sign`, {
          token: strangerToken,
          body: { typedName: "Sam Stranger", bodyHash: agreement.bodyHash },
        })
      ).status,
    ).toBe(404)

    for (const userId of [creator.user.id, builder.user.id]) {
      await insertStripeAccount(testDb.db, userId, {
        payoutsEnabled: true,
        chargesEnabled: true,
        detailsSubmitted: true,
        transfersCapability: "active",
      })
    }
    const ready = await api("GET", `/collabs/${collabId}/agreement`, { token: creatorToken })
    expect(ready.body.agreement).toMatchObject({ canSign: true, blockedReason: null })
    expect(
      await api("POST", `/agreements/${agreement.id}/sign`, {
        token: creatorToken,
        body: { typedName: "Casey Creator", bodyHash: agreement.bodyHash },
      }),
    ).toMatchObject({ status: 200, body: { completed: false, alreadySigned: false } })
    expect(
      await api("POST", `/agreements/${agreement.id}/sign`, {
        token: builderToken,
        body: { typedName: "Bo Builder", bodyHash: agreement.bodyHash },
      }),
    ).toMatchObject({ status: 200, body: { completed: true } })
    const [signedAgreement] = await testDb.db
      .select()
      .from(agreements)
      .where(eq(agreements.id, agreement.id))
    expect(signedAgreement?.status).toBe("signed")
    const [building] = await testDb.db.select().from(collabs).where(eq(collabs.id, collabId))
    expect(building?.stage).toBe("building")

    // Tasks: create (field errors as on the web), complete; strangers cannot touch them.
    expect(
      await api("POST", `/collabs/${collabId}/tasks`, {
        token: builderToken,
        body: { title: " " },
      }),
    ).toMatchObject({ status: 400, body: { error: { fieldErrors: { title: expect.any(Array) } } } })
    const task = await api("POST", `/collabs/${collabId}/tasks`, {
      token: builderToken,
      body: { title: "Wireframes", assigneeUserId: creator.user.id, dueDate: "2026-10-20" },
    })
    expect(task.status).toBe(200)
    const taskId = task.body.taskId as string
    expect(
      (await api("POST", `/tasks/${taskId}/done`, { token: strangerToken, body: { done: true } }))
        .status,
    ).toBe(404)
    expect(
      (await api("POST", `/tasks/${taskId}/done`, { token: creatorToken, body: { done: true } }))
        .status,
    ).toBe(200)
    const tasks = await api("GET", `/collabs/${collabId}/tasks`, { token: creatorToken })
    expect(tasks.body).toMatchObject({ canWork: true, open: [], done: [{ title: "Wireframes" }] })
    const completed = await testDb.db
      .select()
      .from(events)
      .where(and(eq(events.type, "task.completed"), eq(events.subjectId, taskId)))
    expect(completed).toHaveLength(1)

    // Messages: the collab thread, unread for the other member, then read.
    const threadId = collab.body.threadId as string
    const posted = await api("POST", `/threads/${threadId}/messages`, {
      token: builderToken,
      body: { body: "Wireframes are up." },
    })
    expect(posted.status).toBe(200)
    expect(
      (
        await api("POST", `/threads/${threadId}/messages`, {
          token: strangerToken,
          body: { body: "Hello?" },
        })
      ).status,
    ).toBe(404)
    const inbox = await api("GET", "/inbox", { token: creatorToken })
    const collabThread = (
      inbox.body.threads as { id: string; unread: number; parentId: string }[]
    ).find((thread) => thread.id === threadId)
    expect(collabThread).toMatchObject({ unread: 1, parentId: collabId })
    const thread = await api("GET", `/threads/${threadId}`, { token: creatorToken })
    expect(thread.body).toMatchObject({ canPost: true, messages: [{ body: "Wireframes are up." }] })
    expect(
      await api("POST", `/threads/${threadId}/read`, {
        token: creatorToken,
        body: { messageId: posted.body.messageId },
      }),
    ).toMatchObject({ status: 200, body: { changed: true } })
    const sentEvents = await testDb.db.select().from(events).where(eq(events.type, "message.sent"))
    expect(sentEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(sentEvents.map((event) => event.properties))).not.toContain("Wireframes")

    // Notifications arrived for the creator (proposal received, agreement…); mark all read.
    const notes = await api("GET", "/notifications", { token: creatorToken })
    expect((notes.body.items as unknown[]).length).toBeGreaterThan(0)
    expect(
      (await api("POST", "/notifications/read-all", { token: creatorToken })).body.marked,
    ).toBeGreaterThan(0)
    expect((await api("GET", "/me", { token: creatorToken })).body).toMatchObject({
      unread: { notifications: 0 },
    })
  })

  it("lists, saves and dismisses matches with the web's events", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const other = await onboardedCreator(testDb.db)
    const product = await seekingProduct(testDb.db, builder, { topics: ["finance"] })
    const match = await insertMatch(testDb.db, {
      subjectUserId: creator.user.id,
      targetType: "product",
      targetId: product.id,
      score: 0.8,
    })
    const token = await tokenFor(creator.user.id)

    const discover = await api("GET", "/discover", { token })
    expect(discover.status).toBe(200)
    expect(discover.body).toMatchObject({
      role: "creator",
      view: "for_you",
      matches: [{ id: match.id, target: { type: "product", id: product.id } }],
    })
    // Builders' views are not a creator's.
    expect((await api("GET", "/discover?view=briefs", { token })).status).toBe(404)

    expect(
      await api("POST", "/discover/shown", {
        token,
        body: { items: [{ matchId: match.id, rank: 1 }] },
      }),
    ).toMatchObject({ status: 200, body: { recorded: 1 } })
    expect(
      await api("POST", `/discover/matches/${match.id}/save`, { token, body: { rank: 1 } }),
    ).toMatchObject({ status: 200, body: { status: "saved" } })
    const saved = await api("GET", "/discover?view=saved", { token })
    expect(saved.body.matches).toHaveLength(1)
    expect(
      await api("POST", `/discover/matches/${match.id}/click`, { token, body: { rank: 1 } }),
    ).toMatchObject({ status: 200, body: { target: { type: "product", id: product.id } } })

    // Only the person a match was computed for may act on it.
    const otherToken = await tokenFor(other.user.id)
    expect(
      (await api("POST", `/discover/matches/${match.id}/dismiss`, { token: otherToken, body: {} }))
        .status,
    ).toBe(403)

    expect(
      await api("POST", `/discover/matches/${match.id}/dismiss`, { token, body: { rank: 1 } }),
    ).toMatchObject({ status: 200, body: { status: "dismissed" } })
    const [stored] = await testDb.db.select().from(matches).where(eq(matches.id, match.id))
    expect(stored?.status).toBe("dismissed")
    const types = (await eventsOf(testDb.db, match.id)).map((event) => event.type)
    expect(types).toEqual(
      expect.arrayContaining(["match.shown", "match.saved", "match.clicked", "match.dismissed"]),
    )
  })

  it("creates, edits and publishes ideas; drafts stay private", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const token = await tokenFor(creator.user.id)
    const builderToken = await tokenFor(builder.user.id)

    // Publishing needs a problem and a topic (§19.25): field errors, nothing stored.
    const refused = await api("POST", "/ideas", {
      token,
      body: { title: "Meal planner", format: "app", intent: "publish" },
    })
    expect(refused.status).toBe(422)
    expect(refused.body.error?.fieldErrors).toMatchObject({ problem: expect.any(Array) })

    const draft = await api("POST", "/ideas", {
      token,
      body: { title: "Meal planner", format: "app", targetPrice: "9,99", topics: "food, #budget" },
    })
    expect(draft).toMatchObject({ status: 200, body: { status: "draft", published: false } })
    const ideaId = draft.body.id as string
    // A draft is invisible to everyone else.
    expect((await api("GET", `/ideas/${ideaId}`, { token: builderToken })).status).toBe(404)
    expect(
      (
        await api("PATCH", `/ideas/${ideaId}`, {
          token: builderToken,
          body: { title: "Mine", format: "app" },
        })
      ).status,
    ).toBe(404)

    const published = await api("PATCH", `/ideas/${ideaId}`, {
      token,
      body: {
        title: "Meal planner",
        problem: "Students waste food and money.",
        format: "app",
        targetPrice: "9,99",
        topics: "food, #budget",
        intent: "publish",
      },
    })
    expect(published).toMatchObject({ status: 200, body: { status: "open", published: true } })
    const detail = await api("GET", `/ideas/${ideaId}`, { token })
    expect(detail.body).toMatchObject({
      targetPriceCents: 999,
      topics: ["food", "budget"],
      isOwner: true,
    })
    const types = (await eventsOf(testDb.db, ideaId)).map((event) => event.type)
    expect(types).toEqual(["idea.created", "idea.updated", "idea.published"])
    // Builders cannot create ideas.
    expect(
      (await api("POST", "/ideas", { token: builderToken, body: { title: "x", format: "app" } }))
        .status,
    ).toBe(403)
    expect((await api("GET", "/ideas", { token })).body.items).toHaveLength(1)
  })

  it("reads the profile and saves it with the web's form rules", async () => {
    const builder = await onboardedBuilder(testDb.db)
    const token = await tokenFor(builder.user.id)
    const profile = await api("GET", "/profile", { token })
    expect(profile.body).toMatchObject({
      creator: null,
      canEditBuilder: true,
      canEditCreator: false,
    })
    const builderForm = profile.body.builder as Record<string, unknown>
    const saved = await api("PUT", "/profile/builder", {
      token,
      body: { ...builderForm, bio: "I build tools.", skills: ["TypeScript", "typescript", "Go"] },
    })
    expect(saved).toMatchObject({ status: 200, body: { changed: true } })
    expect((await api("GET", "/profile", { token })).body.builder).toMatchObject({
      bio: "I build tools.",
      skills: ["TypeScript", "Go"],
    })
    expect(
      await api("PUT", "/profile/builder", { token, body: { ...builderForm, handle: "admin" } }),
    ).toMatchObject({
      status: 400,
      body: { error: { fieldErrors: { handle: expect.any(Array) } } },
    })
    // Not a creator: no creator profile edits, and the audience page says so.
    expect(
      (await api("PUT", "/profile/creator", { token, body: { displayName: "B", handle: "bbb_b" } }))
        .status,
    ).toBe(403)
    expect((await api("GET", "/audience", { token })).body).toMatchObject({ isCreator: false })
    expect((await api("GET", "/earnings", { token })).body).toMatchObject({
      balances: [],
      payouts: "none",
    })
  })
})
