"use client"

import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CircleCheck,
  EllipsisVertical,
  ListChecks,
  Pencil,
  Plus,
  Trash2,
  UserRound,
} from "lucide-react"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useIsMobile } from "@/hooks/use-mobile"
import { deleteTaskAction, moveTaskAction, setTaskDoneAction } from "@/lib/tasks/actions"
import { formatDueDate, isOverdue } from "@/lib/tasks/fields"
import { cn } from "@/lib/utils"

import { TaskForm, type TaskFormMember, type TaskFormValues } from "./task-form"

/** A task as the board shows it (dates as ISO strings: they cross to the browser). */
export type TaskView = {
  id: string
  title: string
  description: string | null
  assigneeUserId: string | null
  dueDate: string | null
  doneAt: string | null
  completedByUserId: string | null
}

type BoardProps = {
  collabId: string
  members: readonly TaskFormMember[]
  viewerId: string
  /** Members of a collab that has not ended; otherwise the board is read-only. */
  canWork: boolean
  open: readonly TaskView[]
  done: readonly TaskView[]
  /** The page's "now", for overdue dates (ISO). */
  now: string
}

const EMPTY_VALUES: TaskFormValues = { title: "", description: "", assigneeUserId: "", dueDate: "" }

/**
 * The sheet with the task form: from the bottom on phones, from the side elsewhere (§19.20: sheets,
 * not hover). One sheet serves "New task" and "Edit".
 */
function TaskSheet({
  open,
  onOpenChange,
  mode,
  collabId,
  task,
  members,
  viewerId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "edit"
  collabId: string
  task: TaskView | null
  members: readonly TaskFormMember[]
  viewerId: string
}) {
  const isMobile = useIsMobile()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "gap-0 overflow-y-auto overscroll-contain",
          isMobile ? "max-h-[92dvh] rounded-t-2xl pb-safe-2" : "w-full sm:max-w-lg",
        )}
      >
        <SheetHeader>
          <SheetTitle>{mode === "create" ? "New task" : "Edit task"}</SheetTitle>
          <SheetDescription>
            {mode === "create"
              ? "Add the next step and, if you like, who does it and by when."
              : "Change the task; you both see it right away."}
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          {open ? (
            <TaskForm
              mode={mode}
              collabId={collabId}
              taskId={task?.id}
              defaults={
                task
                  ? {
                      title: task.title,
                      description: task.description ?? "",
                      assigneeUserId: task.assigneeUserId ?? "",
                      dueDate: task.dueDate ?? "",
                    }
                  : EMPTY_VALUES
              }
              members={members}
              viewerId={viewerId}
              onDone={() => onOpenChange(false)}
              onCancel={() => onOpenChange(false)}
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** "New task": the header button (from `md` up) or the phone app bar's icon button. */
export function NewTaskButton({
  collabId,
  members,
  viewerId,
  variant,
}: {
  collabId: string
  members: readonly TaskFormMember[]
  viewerId: string
  variant: "header" | "app-bar"
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {variant === "app-bar" ? (
        <Button size="icon" className="size-11" aria-label="New task" onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" />
        </Button>
      ) : (
        <Button onClick={() => setOpen(true)} className="h-11 md:h-9">
          <Plus aria-hidden="true" />
          New task
        </Button>
      )}
      <TaskSheet
        open={open}
        onOpenChange={setOpen}
        mode="create"
        collabId={collabId}
        task={null}
        members={members}
        viewerId={viewerId}
      />
    </>
  )
}

function nameOf(members: readonly TaskFormMember[], userId: string | null, viewerId: string) {
  if (!userId) return null
  if (userId === viewerId) return "You"
  return members.find((member) => member.userId === userId)?.name ?? "A former member"
}

/**
 * The collab's tasks (§12 `/app/collabs/[id]/tasks`): open tasks in their agreed order with a
 * checkbox to tick them off, who does them and when they are due (overdue ones say so), and a menu
 * per task (edit, move up or down, delete); done tasks below, newest first, each with a checkbox
 * to reopen it. Every control is at least 44 px on touch screens.
 */
export function TaskBoard({ collabId, members, viewerId, canWork, open, done, now }: BoardProps) {
  const [editing, setEditing] = useState<TaskView | null>(null)
  const [deleting, setDeleting] = useState<TaskView | null>(null)
  const [pending, startTransition] = useTransition()
  const at = new Date(now)

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success?: string) {
    startTransition(async () => {
      const result = await action()
      if (!result.ok) toast.error(result.error ?? "Something went wrong. Try again.")
      else if (success) toast.success(success)
    })
  }

  function toggle(task: TaskView, doneNow: boolean) {
    run(
      async () => {
        const result = await setTaskDoneAction({ taskId: task.id, done: doneNow })
        return result.ok ? { ok: true } : { ok: false, error: result.error }
      },
      doneNow ? "Task done." : "Task reopened.",
    )
  }

  function move(task: TaskView, direction: "up" | "down") {
    run(async () => {
      const result = await moveTaskAction({ taskId: task.id, direction })
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    })
  }

  function remove(task: TaskView) {
    run(async () => {
      const result = await deleteTaskAction({ taskId: task.id })
      setDeleting(null)
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    }, "Task deleted.")
  }

  const renderTask = (task: TaskView, index: number, list: readonly TaskView[]) => {
    const isDone = task.doneAt !== null
    const assignee = nameOf(members, task.assigneeUserId, viewerId)
    const overdue = !isDone && isOverdue(task.dueDate, at)
    const checkboxId = `task-${task.id}-done`
    return (
      <li key={task.id} className="flex items-start gap-2 p-2 sm:gap-3 sm:p-3">
        <label
          htmlFor={checkboxId}
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-md",
            canWork ? "cursor-pointer hover:bg-accent/50" : "cursor-default",
          )}
        >
          <Checkbox
            id={checkboxId}
            checked={isDone}
            disabled={!canWork || pending}
            onCheckedChange={(value) => toggle(task, value === true)}
            className="size-5"
            aria-label={isDone ? `Reopen “${task.title}”` : `Mark “${task.title}” as done`}
          />
        </label>
        <div className="min-w-0 flex-1 py-2.5">
          <p
            className={cn(
              "font-medium break-words",
              isDone && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </p>
          {task.description ? (
            <p className="mt-1 line-clamp-3 text-sm break-words whitespace-pre-line text-muted-foreground">
              {task.description}
            </p>
          ) : null}
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <UserRound className="size-3.5" aria-hidden="true" />
              {assignee ?? "Nobody yet"}
            </span>
            {task.dueDate ? (
              <span
                className={cn("flex items-center gap-1", overdue && "font-medium text-destructive")}
              >
                <CalendarDays className="size-3.5" aria-hidden="true" />
                {overdue ? "Overdue · " : "Due "}
                {formatDueDate(task.dueDate, at)}
              </span>
            ) : null}
            {isDone && task.doneAt ? (
              <span className="flex items-center gap-1">
                <CircleCheck className="size-3.5" aria-hidden="true" />
                Done by {nameOf(members, task.completedByUserId, viewerId) ?? "someone"} on{" "}
                {formatDueDate(task.doneAt.slice(0, 10), at)}
              </span>
            ) : null}
          </p>
        </div>
        {canWork ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                aria-label={`Options for “${task.title}”`}
                disabled={pending}
              >
                <EllipsisVertical aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem className="min-h-11 sm:min-h-8" onSelect={() => setEditing(task)}>
                <Pencil aria-hidden="true" />
                Edit
              </DropdownMenuItem>
              {!isDone ? (
                <>
                  <DropdownMenuItem
                    className="min-h-11 sm:min-h-8"
                    disabled={index === 0}
                    onSelect={() => move(task, "up")}
                  >
                    <ArrowUp aria-hidden="true" />
                    Move up
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="min-h-11 sm:min-h-8"
                    disabled={index === list.length - 1}
                    onSelect={() => move(task, "down")}
                  >
                    <ArrowDown aria-hidden="true" />
                    Move down
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                className="min-h-11 sm:min-h-8"
                onSelect={() => setDeleting(task)}
              >
                <Trash2 aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </li>
    )
  }

  return (
    <div className="space-y-6">
      {open.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={done.length > 0 ? "Everything is done" : "No tasks yet"}
          description={
            canWork
              ? "Break the work into small steps and decide who does what."
              : "There are no open tasks."
          }
          action={
            canWork ? (
              <NewTaskButton
                collabId={collabId}
                members={members}
                viewerId={viewerId}
                variant="header"
              />
            ) : undefined
          }
        />
      ) : (
        <section aria-labelledby="open-tasks" className="space-y-2">
          <h2 id="open-tasks" className="text-sm font-medium text-muted-foreground">
            To do · {open.length}
          </h2>
          <ol className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {open.map((task, index) => renderTask(task, index, open))}
          </ol>
        </section>
      )}

      {done.length > 0 ? (
        <details className="group space-y-2" open={open.length === 0}>
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-muted-foreground">
            Done · {done.length}
          </summary>
          <ol className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {done.map((task, index) => renderTask(task, index, done))}
          </ol>
        </details>
      ) : null}

      <TaskSheet
        open={editing !== null}
        onOpenChange={(value) => (value ? null : setEditing(null))}
        mode="edit"
        collabId={collabId}
        task={editing}
        members={members}
        viewerId={viewerId}
      />

      <Dialog open={deleting !== null} onOpenChange={(value) => (value ? null : setDeleting(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this task?</DialogTitle>
            <DialogDescription>
              “{deleting?.title}” will be gone for both of you. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" className="h-11 sm:h-9">
                Keep it
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              className="h-11 sm:h-9"
              disabled={pending}
              onClick={() => (deleting ? remove(deleting) : null)}
            >
              Delete task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
