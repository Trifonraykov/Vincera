import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { z } from "zod"

import { CollabHeader } from "@/components/collabs/collab-header"
import { NewTaskButton, TaskBoard, type TaskView } from "@/components/collabs/task-board"
import { canViewCollab, canWorkInCollab } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { now } from "@/lib/clock"
import { loadCollabSummary } from "@/lib/collabs/queries"
import { getDb } from "@/lib/db/client"
import { listCollabTasks, type TaskItem } from "@/lib/tasks/queries"

export const metadata: Metadata = { title: "Tasks" }

type Props = { params: Promise<{ id: string }> }

function toView(task: TaskItem): TaskView {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    assigneeUserId: task.assigneeUserId,
    dueDate: task.dueDate,
    doneAt: task.doneAt?.toISOString() ?? null,
    completedByUserId: task.completedByUserId,
  }
}

/**
 * The collab's tasks (§12 `/app/collabs/[id]/tasks`): members add tasks (title, notes, who does
 * it, due day), tick them off and back, reorder and delete them while the collab has not ended
 * (`canWorkInCollab`); admins read. "New task" is the app bar's action on phones and a header
 * button from `md` up; the form opens in a sheet. Anyone else gets a 404 (`canViewCollab`).
 */
export default async function CollabTasksPage({ params }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  const collab = await loadCollabSummary(db, id)
  if (!collab || !canViewCollab(user, collab)) notFound()

  const canWork = canWorkInCollab(user, collab)
  const { open, done } = await listCollabTasks(db, collab.id)
  const members = collab.members.map((member) => ({
    userId: member.userId,
    name: member.name,
    role: member.role,
  }))

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <CollabHeader
        collab={collab}
        viewerId={user.id}
        section="tasks"
        badges={{ tasks: { count: open.length, label: `${open.length} open tasks` } }}
        appBarAction={
          canWork ? (
            <NewTaskButton
              collabId={collab.id}
              members={members}
              viewerId={user.id}
              variant="app-bar"
            />
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {canWork
            ? "Plan the work together: who does what, and by when."
            : collab.stage === "ended"
              ? "This collab has ended, so its tasks are read-only."
              : "You can read these tasks; only the collab's members change them."}
        </p>
        {canWork && open.length > 0 ? (
          <div className="hidden md:block">
            <NewTaskButton
              collabId={collab.id}
              members={members}
              viewerId={user.id}
              variant="header"
            />
          </div>
        ) : null}
      </div>
      <TaskBoard
        collabId={collab.id}
        members={members}
        viewerId={user.id}
        canWork={canWork}
        open={open.map(toView)}
        done={done.map(toView)}
        now={now().toISOString()}
      />
    </div>
  )
}
