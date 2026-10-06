import "server-only"

import { asc, eq } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { tasks } from "@/lib/db/schema"

/**
 * Reads for `/app/collabs/[id]/tasks`. Callers authorize with `canViewCollab` first; names come
 * from the collab's members (the page has them).
 */

export type TaskItem = {
  id: string
  title: string
  description: string | null
  assigneeUserId: string | null
  dueDate: string | null
  doneAt: Date | null
  completedByUserId: string | null
  createdByUserId: string | null
  position: number
  createdAt: Date
}

/** Open tasks in their order (position, then creation), and done tasks newest first. */
export async function listCollabTasks(
  database: DbOrTx,
  collabId: string,
): Promise<{ open: TaskItem[]; done: TaskItem[] }> {
  const rows = await database
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      assigneeUserId: tasks.assigneeUserId,
      dueDate: tasks.dueDate,
      doneAt: tasks.doneAt,
      completedByUserId: tasks.completedByUserId,
      createdByUserId: tasks.createdByUserId,
      position: tasks.position,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(eq(tasks.collabId, collabId))
    .orderBy(asc(tasks.position), asc(tasks.createdAt), asc(tasks.id))
  const open = rows.filter((row) => row.doneAt === null)
  const done = rows
    .filter((row) => row.doneAt !== null)
    .sort((a, b) => (b.doneAt?.getTime() ?? 0) - (a.doneAt?.getTime() ?? 0))
  return { open, done }
}

/** The collab a task belongs to, or null. */
export async function findTaskCollabId(database: DbOrTx, taskId: string): Promise<string | null> {
  const [row] = await database
    .select({ collabId: tasks.collabId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
  return row?.collabId ?? null
}
