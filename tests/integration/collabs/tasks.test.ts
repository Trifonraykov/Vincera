import { asc, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import { collabs, tasks } from "@/lib/db/schema"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { TASK_MESSAGES } from "@/lib/tasks/fields"
import { listCollabTasks } from "@/lib/tasks/queries"
import {
  createTask,
  deleteTask,
  moveTask,
  setTaskDone,
  TASK_ERRORS,
  updateTask,
} from "@/lib/tasks/service"

import { setupTestDatabase } from "../../helpers/db"
import { insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import {
  acceptedCollab,
  authUserOf,
  eventsOf,
  makeTempDataDir,
  notificationsOf,
  removeTempDataDir,
} from "./helpers"

/**
 * Collab tasks against Postgres (§12 `/app/collabs/[id]/tasks`, CLAUDE.md §19.24 "Tasks"): create,
 * edit, complete and reopen (events, `on_time`), reorder, delete, `task.assigned`, the collab's
 * activity, and who may do what (members of a collab that has not ended; everyone else "not
 * found"). The actions are tested at the end with a mocked session.
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

const { createTaskAction, setTaskDoneAction, moveTaskAction, deleteTaskAction, updateTaskAction } =
  await import("@/lib/tasks/actions")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000

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

const blank = { description: null, assigneeUserId: null, dueDate: null }

async function rejectsWith(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toThrow(message)
}

async function taskRow(id: string) {
  const [row] = await testDb.db.select().from(tasks).where(eq(tasks.id, id))
  if (!row) throw new Error("no task")
  return row
}

async function collabRow(id: string) {
  const [row] = await testDb.db.select().from(collabs).where(eq(collabs.id, id))
  if (!row) throw new Error("no collab")
  return row
}

describe("tasks", () => {
  it("creates a task with an assignee, tells the assignee, and counts as activity", async () => {
    const { creator, builder, collabId } = await acceptedCollab(testDb.db)
    const later = new Date(NOW.getTime() + DAY)
    setClockForTests(later)
    const { taskId } = await createTask(testDb.db, builder.auth, {
      collabId,
      title: "Sketch the onboarding screens",
      description: "Three screens, mobile first.",
      assigneeUserId: creator.user.id,
      dueDate: "2026-10-10",
    })
    expect(await taskRow(taskId)).toMatchObject({
      collabId,
      title: "Sketch the onboarding screens",
      assigneeUserId: creator.user.id,
      dueDate: "2026-10-10",
      createdByUserId: builder.user.id,
      doneAt: null,
      position: 0,
    })
    const [created] = await eventsOf(testDb.db, taskId, "task.created")
    expect(created).toMatchObject({ actorUserId: builder.user.id })
    expect(created?.properties).toEqual({ collab_id: collabId, assigned: true })
    const [notice] = await notificationsOf(testDb.db, creator.user.id, "task.assigned")
    expect(notice?.payload).toEqual({
      collab_id: collabId,
      task_id: taskId,
      task_title: "Sketch the onboarding screens",
      collab_title: "Budget tracker for students",
      assigned_by_name: builder.profile.displayName,
    })
    expect((await collabRow(collabId)).lastActivityAt).toEqual(later)

    // Assigning yourself notifies nobody; tasks go to the end of the list.
    const second = await createTask(testDb.db, builder.auth, {
      collabId,
      title: "Set up the repo",
      ...blank,
      assigneeUserId: builder.user.id,
    })
    expect((await taskRow(second.taskId)).position).toBe(1)
    expect(await notificationsOf(testDb.db, builder.user.id, "task.assigned")).toHaveLength(0)
  })

  it("only assigns members", async () => {
    const { builder, collabId } = await acceptedCollab(testDb.db)
    const stranger = await insertUser(testDb.db)
    const attempt = createTask(testDb.db, builder.auth, {
      collabId,
      title: "Something",
      ...blank,
      assigneeUserId: stranger.id,
    })
    await expect(attempt).rejects.toThrow(TASK_MESSAGES.assigneeInvalid)
    await expect(attempt).rejects.toMatchObject({
      fieldErrors: { assigneeUserId: [TASK_MESSAGES.assigneeInvalid] },
    })
  })

  it("completes and reopens tasks once, with on_time from the due day", async () => {
    const { creator, collabId } = await acceptedCollab(testDb.db)
    const onTime = await createTask(testDb.db, creator.auth, {
      collabId,
      title: "Due today",
      ...blank,
      dueDate: "2026-10-05",
    })
    const late = await createTask(testDb.db, creator.auth, {
      collabId,
      title: "Due yesterday",
      ...blank,
      dueDate: "2026-10-04",
    })
    const undated = await createTask(testDb.db, creator.auth, {
      collabId,
      title: "Any time",
      ...blank,
    })

    for (const { taskId } of [onTime, late, undated]) {
      expect(await setTaskDone(testDb.db, creator.auth, { taskId, done: true })).toEqual({
        collabId,
        changed: true,
      })
    }
    // Ticking it again changes nothing and emits nothing.
    expect(
      await setTaskDone(testDb.db, creator.auth, { taskId: onTime.taskId, done: true }),
    ).toEqual({ collabId, changed: false })
    const onTimes = await Promise.all(
      [onTime, late, undated].map(async ({ taskId }) => {
        const events = await eventsOf(testDb.db, taskId, "task.completed")
        expect(events).toHaveLength(1)
        return events[0]?.properties
      }),
    )
    expect(onTimes).toEqual([
      { collab_id: collabId, on_time: true },
      { collab_id: collabId, on_time: false },
      { collab_id: collabId, on_time: null },
    ])
    expect(await taskRow(onTime.taskId)).toMatchObject({
      doneAt: NOW,
      completedByUserId: creator.user.id,
    })

    await setTaskDone(testDb.db, creator.auth, { taskId: late.taskId, done: false })
    expect(await taskRow(late.taskId)).toMatchObject({
      doneAt: null,
      completedByUserId: null,
      position: 3,
    })
    const reopened = await eventsOf(testDb.db, late.taskId, "task.reopened")
    expect(reopened.map((event) => event.properties)).toEqual([{ collab_id: collabId }])
    const lists = await listCollabTasks(testDb.db, collabId)
    expect(lists.open.map((task) => task.title)).toEqual(["Due yesterday"])
    expect(lists.done.map((task) => task.title)).toEqual(["Due today", "Any time"])
  })

  it("reorders open tasks and renumbers their positions", async () => {
    const { creator, builder, collabId } = await acceptedCollab(testDb.db)
    const ids: string[] = []
    for (const title of ["A", "B", "C"]) {
      ids.push((await createTask(testDb.db, creator.auth, { collabId, title, ...blank })).taskId)
    }
    const [a, b, c] = ids as [string, string, string]
    expect(await moveTask(testDb.db, builder.auth, { taskId: c, direction: "up" })).toEqual({
      collabId,
      moved: true,
    })
    expect(await moveTask(testDb.db, builder.auth, { taskId: a, direction: "up" })).toEqual({
      collabId,
      moved: false,
    })
    const order = async () =>
      (
        await testDb.db
          .select({ title: tasks.title, position: tasks.position })
          .from(tasks)
          .where(eq(tasks.collabId, collabId))
          .orderBy(asc(tasks.position))
      ).map((row) => `${row.title}${row.position}`)
    expect(await order()).toEqual(["A0", "C1", "B2"])
    await moveTask(testDb.db, creator.auth, { taskId: a, direction: "down" })
    expect(await order()).toEqual(["C0", "A1", "B2"])
    expect(await moveTask(testDb.db, creator.auth, { taskId: b, direction: "down" })).toEqual({
      collabId,
      moved: false,
    })
  })

  it("edits a task and notifies a new assignee", async () => {
    const { creator, builder, collabId } = await acceptedCollab(testDb.db)
    const { taskId } = await createTask(testDb.db, creator.auth, {
      collabId,
      title: "Logo",
      ...blank,
    })
    await updateTask(testDb.db, creator.auth, {
      taskId,
      title: "Logo and icon",
      description: "SVG please",
      assigneeUserId: builder.user.id,
      dueDate: "2026-11-01",
    })
    expect(await taskRow(taskId)).toMatchObject({
      title: "Logo and icon",
      description: "SVG please",
      assigneeUserId: builder.user.id,
      dueDate: "2026-11-01",
    })
    expect(await notificationsOf(testDb.db, builder.user.id, "task.assigned")).toHaveLength(1)
    // Saving again with the same assignee notifies nobody new.
    await updateTask(testDb.db, creator.auth, {
      taskId,
      title: "Logo and icon",
      description: null,
      assigneeUserId: builder.user.id,
      dueDate: null,
    })
    expect(await notificationsOf(testDb.db, builder.user.id, "task.assigned")).toHaveLength(1)
  })

  it("deletes a task", async () => {
    const { creator, collabId } = await acceptedCollab(testDb.db)
    const { taskId } = await createTask(testDb.db, creator.auth, {
      collabId,
      title: "Temp",
      ...blank,
    })
    await deleteTask(testDb.db, creator.auth, { taskId })
    expect(await testDb.db.select().from(tasks).where(eq(tasks.id, taskId))).toHaveLength(0)
  })

  it("is only for members of a collab that has not ended", async () => {
    const { creator, collabId } = await acceptedCollab(testDb.db)
    const { taskId } = await createTask(testDb.db, creator.auth, {
      collabId,
      title: "Mine",
      ...blank,
    })
    const stranger = authUserOf(await insertUser(testDb.db, { roles: ["builder"] }))
    const admin = authUserOf(await insertUser(testDb.db, { roles: ["admin"] }))
    for (const user of [stranger, admin]) {
      await rejectsWith(
        createTask(testDb.db, user, { collabId, title: "Nope", ...blank }),
        TASK_ERRORS.collabNotFound,
      )
      await rejectsWith(setTaskDone(testDb.db, user, { taskId, done: true }), TASK_ERRORS.notFound)
      await rejectsWith(
        moveTask(testDb.db, user, { taskId, direction: "up" }),
        TASK_ERRORS.notFound,
      )
      await rejectsWith(deleteTask(testDb.db, user, { taskId }), TASK_ERRORS.notFound)
      await rejectsWith(
        updateTask(testDb.db, user, { taskId, title: "Hijack", ...blank }),
        TASK_ERRORS.notFound,
      )
    }

    await testDb.db
      .update(collabs)
      .set({ stage: "ended", endedAt: NOW, endedReason: "cancelled" })
      .where(eq(collabs.id, collabId))
    await rejectsWith(
      createTask(testDb.db, creator.auth, { collabId, title: "Late", ...blank }),
      TASK_ERRORS.ended,
    )
    await rejectsWith(
      setTaskDone(testDb.db, creator.auth, { taskId, done: true }),
      TASK_ERRORS.ended,
    )
  })
})

describe("task actions", () => {
  it("validate fields, refuse strangers in plain language, and do the work for members", async () => {
    const { creator, builder, collabId } = await acceptedCollab(testDb.db)
    mocks.user = builder.auth

    const empty = new FormData()
    empty.set("collabId", collabId)
    empty.set("title", "  ")
    empty.set("dueDate", "2026-02-30")
    const refused = await createTaskAction(empty)
    expect(refused).toMatchObject({
      ok: false,
      fieldErrors: {
        title: [TASK_MESSAGES.titleMissing],
        dueDate: [TASK_MESSAGES.dueDateInvalid],
      },
    })

    const form = new FormData()
    form.set("collabId", collabId)
    form.set("title", "Write the landing copy")
    form.set("description", "")
    form.set("assigneeUserId", creator.user.id)
    form.set("dueDate", "")
    const created = await createTaskAction(form)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const { taskId } = created.data
    expect(await taskRow(taskId)).toMatchObject({
      description: null,
      dueDate: null,
      assigneeUserId: creator.user.id,
    })

    mocks.user = creator.auth
    expect(await setTaskDoneAction({ taskId, done: true })).toMatchObject({
      ok: true,
      data: { changed: true },
    })
    expect(await moveTaskAction({ taskId, direction: "up" })).toMatchObject({ ok: true })
    const edit = new FormData()
    edit.set("taskId", taskId)
    edit.set("title", "Write the landing copy (v2)")
    expect(await updateTaskAction(edit)).toMatchObject({ ok: true })

    mocks.user = authUserOf(await insertUser(testDb.db, { roles: ["creator"] }))
    expect(await deleteTaskAction({ taskId })).toEqual({ ok: false, error: TASK_ERRORS.notFound })
    expect(await createTaskAction(form)).toEqual({
      ok: false,
      error: TASK_ERRORS.collabNotFound,
    })

    mocks.user = creator.auth
    expect(await deleteTaskAction({ taskId })).toEqual({ ok: true, data: { deleted: true } })
  })
})
