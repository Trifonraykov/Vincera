import "server-only"

import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { canWorkInCollab, type AuthzUser } from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { touchCollabActivity } from "@/lib/collabs/activity"
import { notifyTaskAssigned } from "@/lib/collabs/notifications"
import { loadCollabTitle } from "@/lib/collabs/queries"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { collabMembers, collabs, tasks, type CollabRole, type CollabStage } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { loadPartyNames } from "@/lib/proposals/queries"

import { completedOnTime, TASK_MESSAGES, type TaskFields } from "./fields"

/**
 * Collab tasks (§12 `/app/collabs/[id]/tasks`, CLAUDE.md §19.24 "Tasks"). Members create, edit,
 * complete, reopen, reorder and delete tasks while the collab has not ended (`canWorkInCollab`);
 * everyone else gets "not found". Each change runs in one transaction that first locks the collab
 * row (`FOR NO KEY UPDATE`), so positions stay consistent when both members reorder at once and a
 * collab that ends meanwhile refuses the change. Every change counts as collab activity
 * (`touchCollabActivity`, which the stalled-collab reminder reads).
 *
 * Events: `task.created { collab_id, assigned }`, `task.completed { collab_id, on_time }`,
 * `task.reopened { collab_id }`. The catalog has no event for edits, moves or deletions, so those
 * emit none (CLAUDE.md §19.28). `task.assigned` notifies an assignee other than the actor.
 */

export const TASK_ERRORS = {
  notFound: "We couldn't find that task.",
  collabNotFound: "We couldn't find that collab.",
  ended: "This collab has ended, so its tasks are read-only.",
} as const

type CollabContext = {
  collabId: string
  stage: CollabStage
  members: { userId: string; role: CollabRole }[]
}

/** Lock the collab and check the user may work in it (plain-language refusals). */
async function lockCollabForWork(
  tx: Tx,
  user: AuthzUser,
  collabId: string,
  notFoundMessage: string = TASK_ERRORS.collabNotFound,
): Promise<CollabContext> {
  const [collab] = await tx
    .select({ id: collabs.id, stage: collabs.stage })
    .from(collabs)
    .where(eq(collabs.id, collabId))
    .for("no key update")
  if (!collab) throw new ActionError(notFoundMessage)
  const members = await tx
    .select({ userId: collabMembers.userId, role: collabMembers.role })
    .from(collabMembers)
    .where(eq(collabMembers.collabId, collabId))
  const memberUserIds = members.map((member) => member.userId)
  // Not a member (admins read only): a stranger learns nothing.
  if (!memberUserIds.includes(user.id)) throw new ActionError(notFoundMessage)
  if (!canWorkInCollab(user, { memberUserIds, stage: collab.stage })) {
    throw new ActionError(collab.stage === "ended" ? TASK_ERRORS.ended : notFoundMessage)
  }
  return { collabId, stage: collab.stage, members }
}

function assertAssignee(context: CollabContext, assigneeUserId: string | null): void {
  if (assigneeUserId === null) return
  if (!context.members.some((member) => member.userId === assigneeUserId)) {
    throw new ActionError(TASK_MESSAGES.assigneeInvalid, {
      fieldErrors: { assigneeUserId: [TASK_MESSAGES.assigneeInvalid] },
    })
  }
}

async function nextPosition(tx: Tx, collabId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${tasks.position})` })
    .from(tasks)
    .where(eq(tasks.collabId, collabId))
  return row?.max === null || row?.max === undefined ? 0 : row.max + 1
}

async function notifyAssignee(
  tx: Tx,
  context: CollabContext,
  input: { taskId: string; title: string; assigneeUserId: string; actorUserId: string; at: Date },
): Promise<void> {
  if (input.assigneeUserId === input.actorUserId) return
  const names = await loadPartyNames(tx, context.members)
  await notifyTaskAssigned(tx, {
    userId: input.assigneeUserId,
    collabId: context.collabId,
    taskId: input.taskId,
    taskTitle: input.title,
    collabTitle: await loadCollabTitle(tx, context.collabId),
    assignedByName: names.get(input.actorUserId)?.name ?? "Your collaborator",
    assignedAt: input.at,
  })
}

/** The task with its collab, locked through the collab; refusals in plain language. */
async function lockTask(tx: Tx, user: AuthzUser, taskId: string) {
  const [task] = await tx
    .select({ id: tasks.id, collabId: tasks.collabId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
  if (!task) throw new ActionError(TASK_ERRORS.notFound)
  const context = await lockCollabForWork(tx, user, task.collabId, TASK_ERRORS.notFound)
  const [current] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update")
  if (!current) throw new ActionError(TASK_ERRORS.notFound)
  return { context, task: current }
}

export async function createTask(
  database: DbOrTx,
  user: AuthzUser,
  input: TaskFields & { collabId: string },
): Promise<{ taskId: string }> {
  return withTransaction(async (tx) => {
    const context = await lockCollabForWork(tx, user, input.collabId)
    assertAssignee(context, input.assigneeUserId)
    const at = now()
    const [task] = await tx
      .insert(tasks)
      .values({
        collabId: input.collabId,
        title: input.title,
        description: input.description,
        assigneeUserId: input.assigneeUserId,
        dueDate: input.dueDate,
        createdByUserId: user.id,
        position: await nextPosition(tx, input.collabId),
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: tasks.id })
    if (!task) throw new Error("createTask: no row returned")
    await track(
      "task.created",
      {
        actorUserId: user.id,
        subjectType: "task",
        subjectId: task.id,
        properties: { collab_id: input.collabId, assigned: input.assigneeUserId !== null },
        occurredAt: at,
      },
      tx,
    )
    await touchCollabActivity(tx, input.collabId, at)
    if (input.assigneeUserId) {
      await notifyAssignee(tx, context, {
        taskId: task.id,
        title: input.title,
        assigneeUserId: input.assigneeUserId,
        actorUserId: user.id,
        at,
      })
    }
    return { taskId: task.id }
  }, database)
}

export async function updateTask(
  database: DbOrTx,
  user: AuthzUser,
  input: TaskFields & { taskId: string },
): Promise<{ collabId: string }> {
  return withTransaction(async (tx) => {
    const { context, task } = await lockTask(tx, user, input.taskId)
    assertAssignee(context, input.assigneeUserId)
    const at = now()
    await tx
      .update(tasks)
      .set({
        title: input.title,
        description: input.description,
        assigneeUserId: input.assigneeUserId,
        dueDate: input.dueDate,
        updatedAt: at,
      })
      .where(eq(tasks.id, task.id))
    await touchCollabActivity(tx, task.collabId, at)
    if (input.assigneeUserId && input.assigneeUserId !== task.assigneeUserId) {
      await notifyAssignee(tx, context, {
        taskId: task.id,
        title: input.title,
        assigneeUserId: input.assigneeUserId,
        actorUserId: user.id,
        at,
      })
    }
    return { collabId: task.collabId }
  }, database)
}

/**
 * Tick a task off (`done`) or back open. Idempotent: ticking a done task again changes nothing and
 * emits nothing (a double tap, two members at once).
 */
export async function setTaskDone(
  database: DbOrTx,
  user: AuthzUser,
  input: { taskId: string; done: boolean },
): Promise<{ collabId: string; changed: boolean }> {
  return withTransaction(async (tx) => {
    const { task } = await lockTask(tx, user, input.taskId)
    const at = now()
    if (input.done) {
      const updated = await tx
        .update(tasks)
        .set({ doneAt: at, completedByUserId: user.id, updatedAt: at })
        .where(and(eq(tasks.id, task.id), isNull(tasks.doneAt)))
        .returning({ id: tasks.id })
      if (updated.length === 0) return { collabId: task.collabId, changed: false }
      await track(
        "task.completed",
        {
          actorUserId: user.id,
          subjectType: "task",
          subjectId: task.id,
          properties: { collab_id: task.collabId, on_time: completedOnTime(task.dueDate, at) },
          occurredAt: at,
        },
        tx,
      )
    } else {
      // Back at the bottom of the open list.
      const position = await nextPosition(tx, task.collabId)
      const updated = await tx
        .update(tasks)
        .set({ doneAt: null, completedByUserId: null, position, updatedAt: at })
        .where(and(eq(tasks.id, task.id), isNotNull(tasks.doneAt)))
        .returning({ id: tasks.id })
      if (updated.length === 0) return { collabId: task.collabId, changed: false }
      await track(
        "task.reopened",
        {
          actorUserId: user.id,
          subjectType: "task",
          subjectId: task.id,
          properties: { collab_id: task.collabId },
          occurredAt: at,
        },
        tx,
      )
    }
    await touchCollabActivity(tx, task.collabId, at)
    return { collabId: task.collabId, changed: true }
  }, database)
}

/**
 * Move an open task one place up or down the list. Positions of the open tasks are renumbered
 * 0…n−1 in their shown order (position, then creation), so gaps and ties from earlier changes
 * disappear. Moving past either end changes nothing.
 */
export async function moveTask(
  database: DbOrTx,
  user: AuthzUser,
  input: { taskId: string; direction: "up" | "down" },
): Promise<{ collabId: string; moved: boolean }> {
  return withTransaction(async (tx) => {
    const { task } = await lockTask(tx, user, input.taskId)
    if (task.doneAt) return { collabId: task.collabId, moved: false }
    const open = await tx
      .select({ id: tasks.id, position: tasks.position })
      .from(tasks)
      .where(and(eq(tasks.collabId, task.collabId), isNull(tasks.doneAt)))
      .orderBy(asc(tasks.position), asc(tasks.createdAt), asc(tasks.id))
    const index = open.findIndex((row) => row.id === task.id)
    const target = input.direction === "up" ? index - 1 : index + 1
    if (index < 0 || target < 0 || target >= open.length) {
      return { collabId: task.collabId, moved: false }
    }
    const order = [...open]
    const [moving] = order.splice(index, 1)
    if (!moving) return { collabId: task.collabId, moved: false }
    order.splice(target, 0, moving)
    const at = now()
    for (const [position, row] of order.entries()) {
      if (row.position === position) continue
      await tx.update(tasks).set({ position, updatedAt: at }).where(eq(tasks.id, row.id))
    }
    await touchCollabActivity(tx, task.collabId, at)
    return { collabId: task.collabId, moved: true }
  }, database)
}

export async function deleteTask(
  database: DbOrTx,
  user: AuthzUser,
  input: { taskId: string },
): Promise<{ collabId: string }> {
  return withTransaction(async (tx) => {
    const { task } = await lockTask(tx, user, input.taskId)
    await tx.delete(tasks).where(eq(tasks.id, task.id))
    await touchCollabActivity(tx, task.collabId)
    return { collabId: task.collabId }
  }, database)
}
