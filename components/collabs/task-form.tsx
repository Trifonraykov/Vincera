"use client"

import { Loader2 } from "lucide-react"
import { useEffect, useId, useRef } from "react"
import { toast } from "sonner"

import {
  describe,
  Field,
  FormActions,
  FormErrorAlert,
  NativeSelect,
  useFormAction,
} from "@/components/profiles/form-kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { ActionResult } from "@/lib/actions/result"
import { createTaskAction, updateTaskAction } from "@/lib/tasks/actions"
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX } from "@/lib/tasks/fields"

export type TaskFormMember = { userId: string; name: string; role: "creator" | "builder" }

export type TaskFormValues = {
  title: string
  description: string
  assigneeUserId: string
  dueDate: string
}

const FIELDS = ["title", "description", "assigneeUserId", "dueDate"] as const

/**
 * A task's fields (§12 `/app/collabs/[id]/tasks`): title, notes, who does it (a member or nobody)
 * and a due day. Used in a sheet for "New task" and "Edit". A refused save keeps what was typed;
 * the server's message sits next to its field.
 */
export function TaskForm({
  mode,
  collabId,
  taskId,
  defaults,
  members,
  viewerId,
  onDone,
  onCancel,
}: {
  mode: "create" | "edit"
  collabId: string
  taskId?: string
  defaults: TaskFormValues
  members: readonly TaskFormMember[]
  viewerId: string
  onDone: () => void
  onCancel: () => void
}) {
  const id = useId()
  const action: (formData: FormData) => Promise<ActionResult<unknown>> =
    mode === "create" ? createTaskAction : updateTaskAction
  const form = useFormAction(action)
  const handled = useRef<unknown>(null)

  useEffect(() => {
    if (!form.result?.ok || handled.current === form.result) return
    handled.current = form.result
    toast.success(mode === "create" ? "Task added." : "Task saved.")
    onDone()
  }, [form.result, mode, onDone])

  const titleError = form.fieldError("title")
  const descriptionError = form.fieldError("description")
  const assigneeError = form.fieldError("assigneeUserId")
  const dueError = form.fieldError("dueDate")

  return (
    <form action={form.formAction} noValidate className="space-y-5">
      {mode === "create" ? (
        <input type="hidden" name="collabId" value={collabId} />
      ) : (
        <input type="hidden" name="taskId" value={taskId} />
      )}
      <Field id={`${id}-title`} label="Task" error={titleError}>
        <Input
          id={`${id}-title`}
          name="title"
          defaultValue={form.valueOf("title", defaults.title)}
          maxLength={TASK_TITLE_MAX}
          placeholder="e.g. Sketch the onboarding screens"
          className="h-11 text-base sm:h-9"
          {...describe(`${id}-title`, { error: titleError })}
        />
      </Field>
      <Field id={`${id}-description`} label="Notes" optional error={descriptionError}>
        <Textarea
          id={`${id}-description`}
          name="description"
          rows={3}
          defaultValue={form.valueOf("description", defaults.description)}
          maxLength={TASK_DESCRIPTION_MAX}
          className="text-base"
          {...describe(`${id}-description`, { error: descriptionError })}
        />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id={`${id}-assignee`} label="Who does it" error={assigneeError}>
          <NativeSelect
            id={`${id}-assignee`}
            name="assigneeUserId"
            defaultValue={form.valueOf("assigneeUserId", defaults.assigneeUserId)}
            className="h-11 text-base sm:h-9"
            {...describe(`${id}-assignee`, { error: assigneeError })}
          >
            <option value="">Nobody yet</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.userId === viewerId ? `You (${member.name})` : member.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id={`${id}-due`} label="Due" optional error={dueError}>
          <Input
            id={`${id}-due`}
            name="dueDate"
            type="date"
            defaultValue={form.valueOf("dueDate", defaults.dueDate)}
            className="h-11 text-base sm:h-9"
            {...describe(`${id}-due`, { error: dueError })}
          />
        </Field>
      </div>
      {form.error && form.hasFormError(FIELDS) ? (
        <FormErrorAlert message={form.error.error} />
      ) : null}
      <FormActions className="bottom-0">
        <Button type="button" variant="outline" onClick={onCancel} className="h-11 sm:h-9">
          Cancel
        </Button>
        <Button type="submit" disabled={form.pending} className="h-11 sm:h-9">
          {form.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {mode === "create" ? "Add task" : "Save task"}
        </Button>
      </FormActions>
    </form>
  )
}
