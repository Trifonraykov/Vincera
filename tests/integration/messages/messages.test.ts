import path from "node:path"

import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ActionError } from "@/lib/actions/errors"
import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import { collabs, messages, threadReads, threads, users } from "@/lib/db/schema"
import { createAttachmentUpload, discardMessageUploads } from "@/lib/messages/attachments"
import { attachmentResponse } from "@/lib/messages/download"
import { MESSAGE_MESSAGES, postMessage } from "@/lib/messages/post"
import { declineProposal, sendProposal } from "@/lib/proposals/service"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { createLocalStorage } from "@/lib/storage/local"
import { loadThreadAccess } from "@/lib/threads/access"
import { countUnreadMessages, listInbox, markThreadRead, plainPreview } from "@/lib/threads/queries"

import { setupTestDatabase } from "../../helpers/db"
import { insertCollab } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import {
  authUserOf,
  eventsOf,
  makeTempDataDir,
  onboardedBuilder,
  onboardedCreator,
  openIdea,
  removeTempDataDir,
  terms,
} from "../proposals/helpers"

/**
 * Threads and messages (CLAUDE.md §19.24): posting (events without bodies, last_message_at, the
 * author's read mark, collab activity), who may post, unread counts and the inbox, the rate
 * limit, attachments (signed upload, copy into the thread, checks, cleanup) and their download
 * route, and the post action with a mocked session.
 */

const mocks = vi.hoisted(() => ({ dir: "", db: null as unknown, user: null as AuthUser | null }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
vi.mock("@/lib/auth/session", () => ({
  requireUser: async () => {
    if (!mocks.user) throw new Error("no user")
    return mocks.user
  },
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const { postMessageAction, requestAttachmentUploadAction, markThreadReadAction } =
  await import("@/lib/messages/actions")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")
const MINUTE = 60_000

beforeAll(async () => {
  mocks.dir = await makeTempDataDir()
})
afterAll(async () => {
  await removeTempDataDir(mocks.dir)
})
beforeEach(() => {
  mocks.db = testDb.db
  mocks.user = null
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(async () => {
  setClockForTests(null)
  await closeDb()
})

const storage = () => createLocalStorage(path.join(mocks.dir, "storage"))

async function proposalThread() {
  const creator = await onboardedCreator(testDb.db)
  const builder = await onboardedBuilder(testDb.db)
  const idea = await openIdea(testDb.db, creator, "Recipe planner")
  const sent = await sendProposal(testDb.db, builder.auth, {
    recipientId: creator.user.id,
    target: { kind: "idea", id: idea.id },
    matchId: null,
    terms: terms(),
  })
  return { creator, builder, idea, ...sent }
}

/** What the composer does: a signed upload URL, then the bytes PUT to storage. */
async function uploadFile(
  userId: string,
  options: { contentType?: string; bytes?: number; storedAs?: string } = {},
) {
  const contentType = options.contentType ?? "application/pdf"
  const bytes = options.bytes ?? 2048
  const upload = await createAttachmentUpload({ userId, contentType, sizeBytes: bytes }, storage())
  await storage().putObject(upload.key, new Uint8Array(bytes), options.storedAs ?? contentType)
  return upload.key
}

describe("postMessage", () => {
  it("stores the message, moves the thread and the author's read mark, and records message.sent", async () => {
    const { creator, builder, threadId } = await proposalThread()
    setClockForTests(new Date(NOW.getTime() + MINUTE))

    const { messageId, createdAt } = await postMessage(testDb.db, builder.auth, {
      threadId,
      body: "Hi! **Quick question** about the scope.",
      attachments: [],
    })
    expect(createdAt).toEqual(new Date(NOW.getTime() + MINUTE))
    const [stored] = await testDb.db.select().from(messages).where(eq(messages.id, messageId))
    expect(stored).toMatchObject({ threadId, authorUserId: builder.user.id, attachments: [] })
    const [thread] = await testDb.db.select().from(threads).where(eq(threads.id, threadId))
    expect(thread?.lastMessageAt).toEqual(createdAt)
    const reads = await testDb.db
      .select()
      .from(threadReads)
      .where(eq(threadReads.threadId, threadId))
    expect(reads.find((read) => read.userId === builder.user.id)?.lastReadAt).toEqual(createdAt)
    expect(reads.find((read) => read.userId === creator.user.id)?.lastReadAt).toBeNull()

    const [event] = await eventsOf(testDb.db, threadId, "message.sent")
    expect(event).toMatchObject({ actorUserId: builder.user.id, subjectType: "thread" })
    // Never the body (§11).
    expect(event?.properties).toEqual({ thread_kind: "proposal", attachment_count: 0 })

    expect(await countUnreadMessages(testDb.db, creator.user.id)).toBe(1)
    expect(await countUnreadMessages(testDb.db, builder.user.id)).toBe(0)
  })

  it("counts unread messages per thread, lists the inbox and marks threads read", async () => {
    const first = await proposalThread()
    const second = await proposalThread()
    await postMessage(testDb.db, first.builder.auth, {
      threadId: first.threadId,
      body: "One",
      attachments: [],
    })
    setClockForTests(new Date(NOW.getTime() + MINUTE))
    await postMessage(testDb.db, first.builder.auth, {
      threadId: first.threadId,
      body: "Two\n\n- with a list",
      attachments: [],
    })
    // The creator's reply marks everything before it read for them.
    setClockForTests(new Date(NOW.getTime() + 2 * MINUTE))
    await postMessage(testDb.db, second.creator.auth, {
      threadId: second.threadId,
      body: "Hello",
      attachments: [],
    })

    expect(await countUnreadMessages(testDb.db, first.creator.user.id)).toBe(2)
    const inbox = await listInbox(testDb.db, first.creator.user.id)
    expect(inbox).toEqual([
      expect.objectContaining({
        id: first.threadId,
        kind: "proposal",
        href: `/app/proposals/${first.proposalId}#messages`,
        title: "Recipe planner",
        with: [first.builder.profile.displayName],
        parentStatus: "pending",
        preview: "Two with a list",
        previewByUser: false,
        unread: 2,
      }),
    ])
    expect(await listInbox(testDb.db, second.creator.user.id)).toEqual([
      expect.objectContaining({ id: second.threadId, unread: 0, previewByUser: true }),
    ])

    expect(await markThreadRead(testDb.db, first.creator.user.id, first.threadId)).toBe(true)
    expect(await countUnreadMessages(testDb.db, first.creator.user.id)).toBe(0)
    // Nothing new: nothing changes. A non-participant has no row to move.
    expect(await markThreadRead(testDb.db, first.creator.user.id, first.threadId)).toBe(false)
    expect(await markThreadRead(testDb.db, second.creator.user.id, first.threadId)).toBe(false)
  })

  it("marks read only up to the newest message the page showed", async () => {
    const { creator, builder, threadId } = await proposalThread()
    const shown = await postMessage(testDb.db, builder.auth, {
      threadId,
      body: "On screen",
      attachments: [],
    })
    // Posted after the page rendered, before the browser called the action.
    setClockForTests(new Date(NOW.getTime() + 5 * MINUTE))
    await postMessage(testDb.db, builder.auth, { threadId, body: "Arrived later", attachments: [] })
    expect(await markThreadRead(testDb.db, creator.user.id, threadId, shown.messageId)).toBe(true)
    expect(await countUnreadMessages(testDb.db, creator.user.id)).toBe(1)
    // A message id from another thread moves nothing.
    const other = await proposalThread()
    const foreign = await postMessage(testDb.db, other.builder.auth, {
      threadId: other.threadId,
      body: "Elsewhere",
      attachments: [],
    })
    expect(await markThreadRead(testDb.db, creator.user.id, threadId, foreign.messageId)).toBe(
      false,
    )
  })

  it("lets only participants post, and only while the proposal is open", async () => {
    const { creator, builder, threadId, proposalId } = await proposalThread()
    const stranger = await onboardedBuilder(testDb.db)
    await expect(
      postMessage(testDb.db, stranger.auth, { threadId, body: "Hi", attachments: [] }),
    ).rejects.toThrow(MESSAGE_MESSAGES.notFound)
    const [adminRow] = await testDb.db
      .update(users)
      .set({ roles: ["builder", "admin"] })
      .where(eq(users.id, stranger.user.id))
      .returning()
    if (!adminRow) throw new Error("no admin")
    await expect(
      postMessage(testDb.db, authUserOf(adminRow), { threadId, body: "Hi", attachments: [] }),
    ).rejects.toThrow(ActionError)

    await declineProposal(testDb.db, creator.auth, { proposalId })
    await expect(
      postMessage(testDb.db, builder.auth, { threadId, body: "Wait!", attachments: [] }),
    ).rejects.toThrow(MESSAGE_MESSAGES.closed.proposal)
    expect(await testDb.db.select().from(messages).where(eq(messages.threadId, threadId))).toEqual(
      [],
    )
  })

  it("bumps the collab's activity for collab threads, and refuses ended collabs", async () => {
    const { creator, collab, threadId } = await insertCollab(testDb.db, { stage: "building" })
    const later = new Date(NOW.getTime() + 3 * 24 * 60 * MINUTE)
    setClockForTests(later)
    await postMessage(testDb.db, authUserOf(creator.user), {
      threadId,
      body: "Pushed the first build.",
      attachments: [],
    })
    const [after] = await testDb.db.select().from(collabs).where(eq(collabs.id, collab.id))
    expect(after?.lastActivityAt).toEqual(later)
    const [event] = await eventsOf(testDb.db, threadId, "message.sent")
    expect(event?.properties).toEqual({ thread_kind: "collab", attachment_count: 0 })

    const ended = await insertCollab(testDb.db, { stage: "ended" })
    await expect(
      postMessage(testDb.db, authUserOf(ended.creator.user), {
        threadId: ended.threadId,
        body: "Hello?",
        attachments: [],
      }),
    ).rejects.toThrow(MESSAGE_MESSAGES.closed.collab)
  })

  it("limits messages to 30 a minute per person", async () => {
    const { builder, threadId } = await proposalThread()
    for (let index = 0; index < 30; index++) {
      await postMessage(testDb.db, builder.auth, {
        threadId,
        body: `Message ${index}`,
        attachments: [],
      })
    }
    await expect(
      postMessage(testDb.db, builder.auth, { threadId, body: "One more", attachments: [] }),
    ).rejects.toThrow(MESSAGE_MESSAGES.rateLimited)
    setClockForTests(new Date(NOW.getTime() + MINUTE + 1000))
    await expect(
      postMessage(testDb.db, builder.auth, { threadId, body: "One more", attachments: [] }),
    ).resolves.toMatchObject({ messageId: expect.any(String) })
  })
})

describe("attachments", () => {
  it("copies each upload into the thread, checks the copy and serves it to participants only", async () => {
    const { creator, builder, threadId } = await proposalThread()
    const key = await uploadFile(builder.user.id)
    const { messageId } = await postMessage(
      testDb.db,
      builder.auth,
      { threadId, body: "The brief", attachments: [{ key, filename: "Brief v2.pdf" }] },
      storage(),
    )
    const [stored] = await testDb.db.select().from(messages).where(eq(messages.id, messageId))
    expect(stored?.attachments).toEqual([
      {
        storageKey: expect.stringMatching(
          new RegExp(`^message-attachments/${threadId}/[0-9a-f-]+\\.pdf$`),
        ),
        filename: "Brief v2.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
      },
    ])
    const [event] = await eventsOf(testDb.db, threadId, "message.sent")
    expect(event?.properties).toEqual({ thread_kind: "proposal", attachment_count: 1 })

    // The download route: a redirect for the thread's parties, 404 for everyone else.
    const asCreator = await attachmentResponse(
      { messageId, index: "0" },
      { db: testDb.db, user: creator.auth, storage: storage() },
    )
    expect(asCreator.status).toBe(302)
    expect(asCreator.headers.get("location")).toMatch(/\/api\/dev\/storage\/message-attachments\//)
    const stranger = await onboardedCreator(testDb.db)
    for (const response of [
      await attachmentResponse({ messageId, index: "0" }, { db: testDb.db, user: stranger.auth }),
      await attachmentResponse({ messageId, index: "0" }, { db: testDb.db, user: null }),
      await attachmentResponse({ messageId, index: "1" }, { db: testDb.db, user: creator.auth }),
      await attachmentResponse(
        { messageId: "nope", index: "0" },
        { db: testDb.db, user: creator.auth },
      ),
    ]) {
      expect(response.status).toBe(404)
    }

    // The upload itself is cleaned up after the send.
    await discardMessageUploads(builder.user.id, [{ key }], storage())
    expect(await storage().statObject(key)).toBeNull()
  })

  it("refuses disguised, oversize and foreign uploads, keeping nothing", async () => {
    const { creator, builder, threadId } = await proposalThread()
    const disguised = await uploadFile(builder.user.id, { storedAs: "text/html" })
    await expect(
      postMessage(
        testDb.db,
        builder.auth,
        { threadId, body: "See attached", attachments: [{ key: disguised, filename: "x.pdf" }] },
        storage(),
      ),
    ).rejects.toThrow("You can attach images, PDFs")

    const theirs = await uploadFile(creator.user.id)
    await expect(
      postMessage(
        testDb.db,
        builder.auth,
        { threadId, body: "See attached", attachments: [{ key: theirs, filename: "x.pdf" }] },
        storage(),
      ),
    ).rejects.toThrow("Attach your files again")

    const good = await uploadFile(builder.user.id)
    const missing = `message-uploads/${builder.user.id}/0190a000-0000-7000-8000-00000000ffff.pdf`
    await expect(
      postMessage(
        testDb.db,
        builder.auth,
        {
          threadId,
          body: "Two files",
          attachments: [
            { key: good, filename: "a.pdf" },
            { key: missing, filename: "b.pdf" },
          ],
        },
        storage(),
      ),
    ).rejects.toThrow("We didn't receive “b.pdf”")
    expect(await testDb.db.select().from(messages).where(eq(messages.threadId, threadId))).toEqual(
      [],
    )
    // No copy of the good file was left behind in the thread.
    const leftovers = await storage().statObject(`message-attachments/${threadId}`)
    expect(leftovers).toBeNull()

    await expect(
      createAttachmentUpload(
        { userId: builder.user.id, contentType: "application/pdf", sizeBytes: 26 * 1024 * 1024 },
        storage(),
      ),
    ).rejects.toThrow("The limit is 25 MB")
    await expect(
      createAttachmentUpload(
        { userId: builder.user.id, contentType: "text/html", sizeBytes: 10 },
        storage(),
      ),
    ).rejects.toThrow(ActionError)
  })
})

describe("message actions (mocked session)", () => {
  it("returns field errors for an empty message and deletes the uploads of a refused send", async () => {
    const { builder, threadId } = await proposalThread()
    mocks.user = builder.auth
    const upload = await requestAttachmentUploadAction({
      threadId,
      contentType: "image/png",
      sizeBytes: 512,
    })
    if (!upload.ok) throw new Error(upload.error)
    await createLocalStorage().putObject(upload.data.key, new Uint8Array(512), "image/png")

    const form = new FormData()
    form.set("threadId", threadId)
    form.set("body", "   ")
    form.set("attachments", JSON.stringify([{ key: upload.data.key, filename: "shot.png" }]))
    const refused = await postMessageAction(form)
    expect(refused).toEqual({
      ok: false,
      error: "Please check your message and try again.",
      fieldErrors: { body: ["Write a message."] },
    })
    expect(await createLocalStorage().statObject(upload.data.key)).toBeNull()

    form.set("body", "Here you go")
    const sentWithoutFile = await postMessageAction(form)
    expect(sentWithoutFile).toMatchObject({ ok: false, error: expect.stringMatching(/receive/) })

    form.set("attachments", "[]")
    expect(await postMessageAction(form)).toMatchObject({ ok: true })
  })

  it("refuses strangers and marks threads read for participants", async () => {
    const { creator, builder, threadId } = await proposalThread()
    const { messageId } = await postMessage(testDb.db, builder.auth, {
      threadId,
      body: "Hi",
      attachments: [],
    })
    const stranger = await onboardedCreator(testDb.db)
    mocks.user = stranger.auth
    expect(await postMessageAction({ threadId, body: "Hi", attachments: "[]" })).toEqual({
      ok: false,
      error: MESSAGE_MESSAGES.notFound,
    })
    expect(await markThreadReadAction({ threadId, messageId })).toMatchObject({ ok: false })

    mocks.user = creator.auth
    expect(await markThreadReadAction({ threadId, messageId })).toEqual({
      ok: true,
      data: { changed: true },
    })
    expect(await countUnreadMessages(testDb.db, creator.user.id)).toBe(0)
    expect(
      [...((await loadThreadAccess(testDb.db, threadId))?.participantUserIds ?? [])].sort(),
    ).toEqual([creator.user.id, builder.user.id].sort())
  })
})

describe("plainPreview", () => {
  it("drops Markdown punctuation and code, and shortens", () => {
    expect(plainPreview("**Bold** and _it_ [link](https://x.y)")).toBe("Bold and it link")
    expect(plainPreview("```\ncode\n```\nAfter")).toBe("After")
    expect(plainPreview("a".repeat(200))).toHaveLength(140)
  })
})

describe("ThreadPanel (server-rendered)", () => {
  it("renders messages through the sanitizer, attachment links, and the composer for parties", async () => {
    const { ThreadPanel } = await import("@/components/messages/thread-panel")
    const { createElement } = await import("react")
    const { renderToStaticMarkup } = await import("react-dom/server")
    const { creator, builder, threadId } = await proposalThread()
    await postMessage(testDb.db, builder.auth, {
      threadId,
      body: '**bold** <script>alert(1)</script> [x](javascript:alert(1)) <img src="https://x.y/i.png">',
      attachments: [],
    })
    const thread = await loadThreadAccess(testDb.db, threadId)
    if (!thread) throw new Error("no thread")
    const render = async (viewer: AuthUser) =>
      renderToStaticMarkup(
        createElement(
          "div",
          null,
          await ThreadPanel({ db: testDb.db, thread, viewer, closedNote: "Closed." }),
        ),
      )

    const html = await render(creator.auth)
    expect(html).toContain("<strong>bold</strong>")
    // (React's own form-replay script and placeholder action are part of any static render.)
    expect(html).not.toContain("<script>alert")
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('<a target="_blank" rel="nofollow noopener noreferrer">x</a>')
    expect(html).not.toContain("<img")
    expect(html).toContain(builder.profile.displayName)
    expect(html).toContain('aria-label="Attach files"')

    // A closed proposal: read-only, with the note instead of the composer.
    await declineProposal(testDb.db, creator.auth, { proposalId: thread.proposalId ?? "" })
    const closed = await loadThreadAccess(testDb.db, threadId)
    if (!closed) throw new Error("no thread")
    const readOnly = renderToStaticMarkup(
      createElement(
        "div",
        null,
        await ThreadPanel({
          db: testDb.db,
          thread: closed,
          viewer: creator.auth,
          closedNote: "Closed.",
        }),
      ),
    )
    expect(readOnly).toContain("Closed.")
    expect(readOnly).not.toContain('aria-label="Attach files"')
  })
})
