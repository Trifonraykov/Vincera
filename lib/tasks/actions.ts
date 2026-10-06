"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import { canWorkInCollab, type AuthzUser } from "@/lib/auth/authz"
import { loadCollabAccess } from "@/lib/collabs/queries"
import { getDb } from "@/lib/db/client"

import { taskFields } from "./fields"
import { findTaskCollabId } from "./queries"
import { createTask, deleteTask, moveTask, setTaskDone, TASK_ERRORS, updateTask } from "./service"

/**
 * Task server actions (§4). `authorize` uses `canWorkInCollab` (members of a collab that has not
 * ended; CLAUDE.md §6), with plain-language refusals; ./service.ts checks again under the collab's
 * lock.
 */

const id = (what: string) => z.uuid({ error: `That ${what} link is not valid.` })

async function authorizeCollab(
  user: AuthzUser,
  collabId: string | null,
  notFound: string,
): Promise<boolean> {
  const collab = collabId ? await loadCollabAccess(getDb(), collabId) : null
  if (!collab || !collab.memberUserIds.includes(user.id)) throw new ActionError(notFound)
  if (collab.stage === "ended") throw new ActionError(TASK_ERRORS.ended)
  return canWorkInCollab(user, collab)
}

async function authorizeTask(user: AuthzUser, taskId: string): Promise<boolean> {
  return authorizeCollab(user, await findTaskCollabId(getDb(), taskId), TASK_ERRORS.notFound)
}

/** The tasks page, the overview's counts, the collab list and the home page all show tasks. */
function revalidateCollabPages(): void {
  revalidatePath("/app", "layout")
}

export const createTaskAction = defineAction({
  name: "tasks.create",
  input: z.object({ collabId: id("collab"), ...taskFields }),
  authorize: (user, input) => authorizeCollab(user, input.collabId, TASK_ERRORS.collabNotFound),
  run: async ({ input, user, db }) => {
    const result = await createTask(db, user, input)
    revalidateCollabPages()
    return result
  },
})

export const updateTaskAction = defineAction({
  name: "tasks.update",
  input: z.object({ taskId: id("task"), ...taskFields }),
  authorize: (user, input) => authorizeTask(user, input.taskId),
  run: async ({ input, user, db }) => {
    const result = await updateTask(db, user, input)
    revalidateCollabPages()
    return result
  },
})

export const setTaskDoneAction = defineAction({
  name: "tasks.set_done",
  input: z.object({ taskId: id("task"), done: z.boolean() }),
  authorize: (user, input) => authorizeTask(user, input.taskId),
  run: async ({ input, user, db }) => {
    const result = await setTaskDone(db, user, input)
    revalidateCollabPages()
    return result
  },
})

export const moveTaskAction = defineAction({
  name: "tasks.move",
  input: z.object({ taskId: id("task"), direction: z.enum(["up", "down"]) }),
  authorize: (user, input) => authorizeTask(user, input.taskId),
  run: async ({ input, user, db }) => {
    const result = await moveTask(db, user, input)
    revalidateCollabPages()
    return result
  },
})

export const deleteTaskAction = defineAction({
  name: "tasks.delete",
  input: z.object({ taskId: id("task") }),
  authorize: (user, input) => authorizeTask(user, input.taskId),
  run: async ({ input, user, db }) => {
    await deleteTask(db, user, input)
    revalidateCollabPages()
    return { deleted: true as const }
  },
})
