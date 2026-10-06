import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ACTION_MESSAGES } from "@/lib/actions/result"
import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { sha256Hex } from "@/lib/crypto"
import { ideas } from "@/lib/db/schema"
import { ideaEmbeddingText } from "@/lib/embeddings/entities"
import { sealBrief } from "@/lib/ideas/brief"
import type { IdeaFields } from "@/lib/ideas/fields"
import { countOwnIdeas, findIdea, findIdeaAccess, listOwnIdeas } from "@/lib/ideas/queries"
import { createIdea, transitionIdea, updateIdea } from "@/lib/ideas/save"

import { setupTestDatabase } from "../../helpers/db"
import { insertIdea } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import {
  eventsOf,
  formData,
  newBuilder,
  newCreator,
  newUserWithoutProfile,
  redirectTarget,
  stubMatchingJobs,
} from "./helpers"

/**
 * Ideas (§5, §12 `/app/ideas/*`, §11 `idea.*`; CLAUDE.md §19.24–§19.25): writes with their events
 * and lifecycle, ownership, locked statuses, the server actions (authorization, field errors,
 * redirects), the embedding refresh they request, and the AI brief drafter with its
 * `ai.generated` / `ai.reviewed` events.
 */

const mocks = vi.hoisted(() => ({ user: null as AuthUser | null, db: null as unknown }))

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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const { changeIdeaStatusAction, createIdeaAction, draftIdeaBriefAction, updateIdeaAction } =
  await import("@/lib/ideas/actions")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")

beforeEach(() => {
  stubServiceEnv()
  setClockForTests(NOW)
  mocks.db = testDb.db
  mocks.user = null
})
afterEach(() => setClockForTests(null))

const FIELDS: IdeaFields = {
  title: "Budget planner for students",
  problem: "Students run out of money before the month ends.",
  audienceEvidence: "40 comments asked for it.",
  format: "template",
  targetPrice: 1900,
  topics: ["budgeting", "students"],
}

async function ideaRow(id: string) {
  const [row] = await testDb.db.select().from(ideas).where(eq(ideas.id, id))
  if (!row) throw new Error("no idea")
  return row
}

describe("idea writes", () => {
  it("saves a draft with idea.created and nothing visible to others", async () => {
    const { user } = await newCreator(testDb.db)
    const result = await createIdea(testDb.db, { userId: user.id, fields: FIELDS, intent: "save" })
    expect(result).toMatchObject({ status: "draft", published: false })
    const row = await ideaRow(result.ideaId)
    expect(row).toMatchObject({
      title: FIELDS.title,
      targetPriceCents: 1900,
      currency: "eur",
      status: "draft",
      publishedAt: null,
      archivedAt: null,
    })
    const events = await eventsOf(testDb.db, result.ideaId)
    expect(events.map((event) => event.type)).toEqual(["idea.created"])
    expect(events[0]).toMatchObject({
      actorUserId: user.id,
      subjectType: "idea",
      properties: {
        format: "template",
        topics: ["budgeting", "students"],
        target_price_cents: 1900,
      },
    })
  })

  it("publishes at once with idea.created then idea.published", async () => {
    const { user } = await newCreator(testDb.db)
    const result = await createIdea(testDb.db, {
      userId: user.id,
      fields: FIELDS,
      intent: "publish",
    })
    expect(await ideaRow(result.ideaId)).toMatchObject({ status: "open", publishedAt: NOW })
    expect((await eventsOf(testDb.db, result.ideaId)).map((event) => event.type)).toEqual([
      "idea.created",
      "idea.published",
    ])
  })

  it("refuses to publish without a problem and a topic, and to create without a profile", async () => {
    const { user } = await newCreator(testDb.db)
    const refused = createIdea(testDb.db, {
      userId: user.id,
      fields: { ...FIELDS, problem: null, topics: [] },
      intent: "publish",
    })
    await expect(refused).rejects.toMatchObject({
      message: "Finish these before publishing.",
      fieldErrors: {
        problem: ["Describe the problem before publishing."],
        topics: ["Add at least one topic before publishing, so builders can find it."],
      },
    })
    expect(await listOwnIdeas(testDb.db, user.id, "all")).toEqual([])

    const { user: noProfile } = await newUserWithoutProfile(testDb.db, "creator")
    await expect(
      createIdea(testDb.db, { userId: noProfile.id, fields: FIELDS, intent: "save" }),
    ).rejects.toThrow("Create your creator profile first.")
  })

  it("records only the changed columns, publishes a draft from the form, and saves nothing new", async () => {
    const { user } = await newCreator(testDb.db)
    const { ideaId } = await createIdea(testDb.db, {
      userId: user.id,
      fields: FIELDS,
      intent: "save",
    })

    const unchanged = await updateIdea(testDb.db, {
      userId: user.id,
      ideaId,
      fields: FIELDS,
      intent: "save",
    })
    expect(unchanged).toMatchObject({ fields: [], published: false, status: "draft" })

    const later = new Date("2026-10-06T08:00:00.000Z")
    setClockForTests(later)
    const result = await updateIdea(testDb.db, {
      userId: user.id,
      ideaId,
      fields: {
        ...FIELDS,
        title: "Weekly budget planner",
        topics: ["budgeting"],
        targetPrice: null,
      },
      intent: "publish",
    })
    expect(result).toMatchObject({
      status: "open",
      published: true,
      fields: ["title", "target_price_cents", "topics"],
    })
    expect(await ideaRow(ideaId)).toMatchObject({
      title: "Weekly budget planner",
      targetPriceCents: null,
      status: "open",
      publishedAt: later,
    })
    const events = await eventsOf(testDb.db, ideaId)
    expect(events.map((event) => [event.type, event.properties])).toEqual([
      ["idea.created", expect.anything()],
      ["idea.updated", { fields: ["title", "target_price_cents", "topics"] }],
      ["idea.published", {}],
    ])

    // On a published idea "publish" just saves.
    const again = await updateIdea(testDb.db, {
      userId: user.id,
      ideaId,
      fields: {
        ...FIELDS,
        title: "Weekly budget planner v2",
        topics: ["budgeting"],
        targetPrice: null,
      },
      intent: "publish",
    })
    expect(again).toMatchObject({ status: "open", published: false, fields: ["title"] })
  })

  it("archives and restores with their events, and publishes the restored draft again", async () => {
    const { user } = await newCreator(testDb.db)
    const { ideaId } = await createIdea(testDb.db, {
      userId: user.id,
      fields: FIELDS,
      intent: "publish",
    })
    expect(await transitionIdea(testDb.db, { userId: user.id, ideaId, action: "archive" })).toEqual(
      {
        ideaId,
        from: "open",
        status: "archived",
      },
    )
    expect(await ideaRow(ideaId)).toMatchObject({ status: "archived", archivedAt: NOW })
    await expect(
      updateIdea(testDb.db, { userId: user.id, ideaId, fields: FIELDS, intent: "save" }),
    ).rejects.toThrow("This idea is archived. Restore it to edit it.")
    await expect(
      transitionIdea(testDb.db, { userId: user.id, ideaId, action: "archive" }),
    ).rejects.toThrow("This idea is already archived.")

    await transitionIdea(testDb.db, { userId: user.id, ideaId, action: "restore" })
    expect(await ideaRow(ideaId)).toMatchObject({ status: "draft", archivedAt: null })
    await transitionIdea(testDb.db, { userId: user.id, ideaId, action: "publish" })
    expect((await ideaRow(ideaId)).status).toBe("open")

    const types = (await eventsOf(testDb.db, ideaId)).map((event) => event.type)
    expect(types).toEqual([
      "idea.created",
      "idea.published",
      "idea.archived",
      "idea.restored",
      "idea.published",
    ])
    const [archived] = await eventsOf(testDb.db, ideaId, "idea.archived")
    expect(archived?.properties).toEqual({ from_status: "open" })
  })

  it("locks ideas in a collab or launched, and refuses other people's ideas", async () => {
    const { user, profile } = await newCreator(testDb.db)
    for (const status of ["in_collab", "launched"] as const) {
      const idea = await insertIdea(testDb.db, profile.id, { status, problem: "p", topics: ["t"] })
      await expect(
        updateIdea(testDb.db, { userId: user.id, ideaId: idea.id, fields: FIELDS, intent: "save" }),
      ).rejects.toThrow(/so it can't be changed/)
      await expect(
        transitionIdea(testDb.db, { userId: user.id, ideaId: idea.id, action: "archive" }),
      ).rejects.toThrow(/so it can't be changed/)
      expect((await ideaRow(idea.id)).status).toBe(status)
    }

    const other = await newCreator(testDb.db)
    const theirs = await insertIdea(testDb.db, other.profile.id)
    await expect(
      updateIdea(testDb.db, { userId: user.id, ideaId: theirs.id, fields: FIELDS, intent: "save" }),
    ).rejects.toThrow("This idea no longer exists.")
    await expect(
      transitionIdea(testDb.db, { userId: user.id, ideaId: theirs.id, action: "archive" }),
    ).rejects.toThrow("This idea no longer exists.")
  })

  it("lists the creator's own ideas by filter, with counts", async () => {
    const { user, profile } = await newCreator(testDb.db)
    const other = await newCreator(testDb.db)
    await insertIdea(testDb.db, profile.id, { title: "Draft one" })
    await insertIdea(testDb.db, profile.id, { title: "Open one", status: "open" })
    await insertIdea(testDb.db, profile.id, { title: "Old one", status: "archived" })
    await insertIdea(testDb.db, other.profile.id, { title: "Not mine", status: "open" })

    expect(
      (await listOwnIdeas(testDb.db, user.id, "all")).map((idea) => idea.title).sort(),
    ).toEqual(["Draft one", "Open one"])
    expect((await listOwnIdeas(testDb.db, user.id, "archived")).map((idea) => idea.title)).toEqual([
      "Old one",
    ])
    expect(await countOwnIdeas(testDb.db, user.id)).toEqual({
      draft: 1,
      open: 1,
      in_collab: 0,
      launched: 0,
      archived: 1,
    })
    const found = await findIdea(testDb.db, (await listOwnIdeas(testDb.db, user.id, "live"))[0]!.id)
    expect(found?.owner).toMatchObject({ userId: user.id, handle: profile.handle })
    expect(await findIdeaAccess(testDb.db, "0190a000-0000-7000-8000-00000000abcd")).toBeNull()
  })
})

describe("idea actions", () => {
  it("create: redirects to the idea, embeds it after the commit and asks matching to recompute", async () => {
    const matching = stubMatchingJobs()
    const { user, auth } = await newCreator(testDb.db)
    mocks.user = auth
    const target = await redirectTarget(
      createIdeaAction(
        formData({
          title: "Budget planner",
          format: "template",
          targetPrice: "19,90",
          problem: "Money runs out.",
          audienceEvidence: "",
          topics: "Budgeting, #students",
          intent: "publish",
        }),
      ),
    )
    const [idea] = await listOwnIdeas(testDb.db, user.id, "all")
    if (!idea) throw new Error("not created")
    expect(target).toBe(`/app/ideas/${idea.id}?saved=published`)

    const row = await ideaRow(idea.id)
    expect(row).toMatchObject({
      status: "open",
      targetPriceCents: 1990,
      topics: ["budgeting", "students"],
      embeddingModel: "fake:hashed-bow-1024",
      embeddedAt: NOW,
      embeddingTextHash: sha256Hex(ideaEmbeddingText(row)),
    })
    expect(row.embedding).toHaveLength(1024)
    expect(matching.rescore[0]).toHaveBeenCalledWith({ targetType: "idea", targetId: idea.id })
    expect(matching.recompute[0]).toHaveBeenCalledWith({ userId: user.id, reason: "idea_changed" })
  })

  it("create: returns field errors, and refuses users who are not creators", async () => {
    const { auth } = await newCreator(testDb.db)
    mocks.user = auth
    expect(
      await createIdeaAction(formData({ title: "", format: "nope", targetPrice: "abc" })),
    ).toEqual({
      ok: false,
      error: ACTION_MESSAGES.invalidInput,
      fieldErrors: {
        title: ["Give your idea a title."],
        format: ["Pick a format."],
        targetPrice: ["Enter a price like 19 or 19.99."],
      },
    })
    expect(
      await createIdeaAction(formData({ title: "Idea", format: "app", intent: "publish" })),
    ).toMatchObject({
      ok: false,
      fieldErrors: { problem: ["Describe the problem before publishing."] },
    })

    mocks.user = (await newBuilder(testDb.db)).auth
    expect(await createIdeaAction(formData({ title: "Idea", format: "app" }))).toEqual({
      ok: false,
      error: ACTION_MESSAGES.forbidden,
    })
  })

  it("update and status changes: owner only, re-embedding when the text changes", async () => {
    stubMatchingJobs()
    const { user, auth } = await newCreator(testDb.db)
    const { ideaId } = await createIdea(testDb.db, {
      userId: user.id,
      fields: FIELDS,
      intent: "save",
    })

    mocks.user = (await newCreator(testDb.db)).auth
    const intruder = await updateIdeaAction(
      formData({ ideaId, title: "Mine now", format: "app", intent: "save" }),
    )
    expect(intruder).toEqual({ ok: false, error: ACTION_MESSAGES.forbidden })
    expect(await changeIdeaStatusAction({ ideaId, action: "archive" })).toEqual({
      ok: false,
      error: ACTION_MESSAGES.forbidden,
    })

    mocks.user = auth
    const saved = await updateIdeaAction(
      formData({
        ideaId,
        title: "A new title",
        format: "template",
        problem: FIELDS.problem ?? "",
        audienceEvidence: FIELDS.audienceEvidence ?? "",
        targetPrice: "19",
        topics: "budgeting, students",
        intent: "save",
      }),
    )
    expect(saved).toEqual({
      ok: true,
      data: { status: "draft", published: false, changed: ["title"] },
    })
    const row = await ideaRow(ideaId)
    expect(row.embeddingTextHash).toBe(sha256Hex(ideaEmbeddingText(row)))
    expect(ideaEmbeddingText(row)).toContain("Idea: A new title")

    expect(await changeIdeaStatusAction({ ideaId, action: "archive" })).toEqual({
      ok: true,
      data: { status: "archived" },
    })
    expect(await changeIdeaStatusAction({ ideaId, action: "restore" })).toEqual({
      ok: true,
      data: { status: "draft" },
    })
    expect(await changeIdeaStatusAction({ ideaId, action: "restore" })).toEqual({
      ok: false,
      error: "Only archived ideas can be restored.",
    })
  })
})

describe("idea brief drafter", () => {
  const COMMENTS = [
    "Can you make a budget template for students?",
    "please make a budget spreadsheet, I'm broke by the 20th",
    "a budget template for students would be amazing",
  ].join("\n")

  it("drafts fields, records ai.generated, and ai.reviewed when the creator saves it unchanged", async () => {
    stubMatchingJobs()
    const { user, auth } = await newCreator(testDb.db)
    mocks.user = auth
    const drafted = await draftIdeaBriefAction({ comments: COMMENTS })
    if (!drafted.ok) throw new Error(drafted.error)
    const { draft, token } = drafted.data
    expect(draft).toMatchObject({ title: "Budget template for students", format: "template" })
    expect(draft.topics).toContain("budget")

    const [generated, ...more] = await eventsOf(testDb.db, user.id, "ai.generated")
    expect(more).toEqual([])
    expect(generated).toMatchObject({
      actorUserId: user.id,
      subjectType: "user",
      properties: {
        use: "idea_brief",
        prompt_version: "idea_brief@v1",
        accepted_by_user: null,
        fallback: false,
      },
    })
    // Never the comments themselves (§11).
    expect(JSON.stringify(generated?.properties)).not.toContain("broke")

    const target = await redirectTarget(
      createIdeaAction(
        formData({
          title: draft.title,
          problem: draft.problem,
          audienceEvidence: draft.audienceEvidence,
          format: draft.format ?? "other",
          targetPrice: String((draft.targetPriceCents ?? 0) / 100),
          topics: draft.topics.join(", "),
          brief: token,
          intent: "save",
        }),
      ),
    )
    const ideaId = target.split("/")[3]?.split("?")[0] ?? ""
    const [reviewed] = await eventsOf(testDb.db, ideaId, "ai.reviewed")
    expect(reviewed).toMatchObject({
      actorUserId: user.id,
      subjectType: "idea",
      properties: {
        use: "idea_brief",
        prompt_version: "idea_brief@v1",
        accepted: true,
        edited: false,
      },
    })
  })

  it("records a rewrite as not accepted, and ignores a brief sealed for someone else", async () => {
    const { user, auth } = await newCreator(testDb.db)
    const draft = {
      title: "Budget template for students",
      problem: "Students run out of money and want a simple budget template.",
      audienceEvidence: "3 comments asked for it.",
      format: "template" as const,
      targetPriceCents: 1900,
      topics: ["budget"],
    }
    const token = sealBrief(user.id, { promptVersion: "idea_brief@v1", draft, generatedAt: NOW })
    const rewritten = await createIdea(testDb.db, {
      userId: user.id,
      fields: {
        ...FIELDS,
        title: "Meal prep calendar",
        problem: "Parents plan dinners.",
        audienceEvidence: null,
      },
      intent: "save",
      brief: { promptVersion: "idea_brief@v1", draft },
    })
    const [review] = await eventsOf(testDb.db, rewritten.ideaId, "ai.reviewed")
    expect(review?.properties).toMatchObject({ accepted: false, edited: true })

    // The same sealed brief sent by another creator is ignored: the idea is saved, no review.
    stubMatchingJobs()
    const other = await newCreator(testDb.db)
    mocks.user = other.auth
    const target = await redirectTarget(
      createIdeaAction(formData({ title: "Theirs", format: "app", brief: token })),
    )
    const otherIdeaId = target.split("/")[3]?.split("?")[0] ?? ""
    expect(await eventsOf(testDb.db, otherIdeaId, "ai.reviewed")).toEqual([])
    // A day later the brief has expired for its own author too.
    mocks.user = auth
    setClockForTests(new Date("2026-10-06T12:00:01.000Z"))
    const late = await redirectTarget(
      createIdeaAction(formData({ title: "Late", format: "app", brief: token })),
    )
    expect(
      await eventsOf(testDb.db, late.split("/")[3]?.split("?")[0] ?? "", "ai.reviewed"),
    ).toEqual([])
  })

  it("never blocks: a model failure is a plain message and recorded as a fallback", async () => {
    const { user, auth } = await newCreator(testDb.db)
    mocks.user = auth
    const failed = await draftIdeaBriefAction({ comments: `${COMMENTS}\nFAKE_AI_ERROR` })
    expect(failed).toEqual({
      ok: false,
      error:
        "We couldn't draft it right now. Fill in the fields yourself, or try again in a moment.",
    })
    const [generated] = await eventsOf(testDb.db, user.id, "ai.generated")
    expect(generated?.properties).toMatchObject({ use: "idea_brief", fallback: true })
  })

  it("checks the comments, the creator profile and the hourly limit", async () => {
    const { auth } = await newCreator(testDb.db)
    mocks.user = auth
    expect(await draftIdeaBriefAction({ comments: "too short" })).toMatchObject({
      ok: false,
      fieldErrors: { comments: ["Paste a few comments from your audience."] },
    })
    for (let index = 0; index < 10; index++) {
      expect((await draftIdeaBriefAction({ comments: `${COMMENTS} ${index}` })).ok).toBe(true)
    }
    expect(await draftIdeaBriefAction({ comments: COMMENTS })).toEqual({
      ok: false,
      error: "You've drafted a few ideas already. Fill in the fields yourself, or try again later.",
    })

    mocks.user = (await newUserWithoutProfile(testDb.db, "creator")).auth
    expect(await draftIdeaBriefAction({ comments: COMMENTS })).toEqual({
      ok: false,
      error: "Create your creator profile first.",
    })
    mocks.user = (await newBuilder(testDb.db)).auth
    expect(await draftIdeaBriefAction({ comments: COMMENTS })).toEqual({
      ok: false,
      error: ACTION_MESSAGES.forbidden,
    })
  })
})
