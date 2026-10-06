"use client"

import { CheckCircle2, Loader2, Pause, Play, Rocket, Send, Square, Undo2 } from "lucide-react"
import { useActionState, useId, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { ActionResult } from "@/lib/actions/result"
import {
  adminApproveLaunchAction,
  adminEndLaunchAction,
  adminRejectLaunchAction,
  approveLaunchAction,
  createLaunchAction,
  pauseLaunchAction,
  resumeLaunchAction,
} from "@/lib/launches/actions"
import { REVIEW_NOTE_MAX } from "@/lib/launches/fields"
import { cn } from "@/lib/utils"

/**
 * The launch's one-click actions (§12): start the setup, approve, pause, resume, and the admin
 * review. Each is a small form, so it works before hydration finishes; the page re-renders with
 * the new status after the action (`revalidatePath`). Refusals are shown next to the button.
 */

type Result = ActionResult<unknown> | null

function ErrorText({ state, className }: { state: Result; className?: string }) {
  if (!state || state.ok) return null
  return (
    <p role="alert" className={cn("text-sm text-destructive", className)}>
      {state.error}
    </p>
  )
}

function Spinner({ pending, icon }: { pending: boolean; icon: ReactNode }) {
  return pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : icon
}

function useAction(run: () => Promise<ActionResult<unknown>>, success?: string) {
  return useActionState(async (): Promise<Result> => {
    const result = await run()
    if (result.ok && success) toast.success(success)
    return result
  }, null)
}

const fullOnPhone = "h-11 w-full sm:h-9 sm:w-auto"

export function StartLaunchButton({ collabId }: { collabId: string }) {
  const [state, action, pending] = useAction(() => createLaunchAction({ collabId }))
  return (
    <form action={action} className="space-y-2">
      <Button type="submit" disabled={pending} className={fullOnPhone}>
        <Spinner pending={pending} icon={<Rocket aria-hidden="true" />} />
        Set up the launch
      </Button>
      <ErrorText state={state} />
    </form>
  )
}

export function ApproveButton({ launchId, label }: { launchId: string; label?: string }) {
  const [state, action, pending] = useAction(() => approveLaunchAction({ launchId }), "Approved.")
  return (
    <form action={action} className="space-y-2">
      <Button type="submit" disabled={pending} className={fullOnPhone}>
        <Spinner pending={pending} icon={<CheckCircle2 aria-hidden="true" />} />
        {label ?? "Approve this version"}
      </Button>
      <ErrorText state={state} />
    </form>
  )
}

export function ResumeButton({ launchId }: { launchId: string }) {
  const [state, action, pending] = useAction(
    () => resumeLaunchAction({ launchId }),
    "Sales are back on.",
  )
  return (
    <form action={action} className="space-y-2">
      <Button type="submit" disabled={pending} className={fullOnPhone}>
        <Spinner pending={pending} icon={<Play aria-hidden="true" />} />
        Resume sales
      </Button>
      <ErrorText state={state} />
    </form>
  )
}

/** Pause sales, after a confirmation. Members and admins. */
export function PauseButton({ launchId, title }: { launchId: string; title: string }) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(async (): Promise<Result> => {
    const result = await pauseLaunchAction({ launchId })
    if (result.ok) {
      setOpen(false)
      toast.success("Sales are paused.")
    }
    return result
  }, null)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className={fullOnPhone}>
          <Pause aria-hidden="true" />
          Pause sales
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pause sales of “{title}”?</DialogTitle>
          <DialogDescription>
            The product page will say it&apos;s unavailable and nobody can buy it. Buyers keep their
            access. You can start sales again whenever you like. If you change the launch while
            it&apos;s paused, you both approve the new version and our team reviews it first.
          </DialogDescription>
        </DialogHeader>
        <ErrorText state={state} />
        <form action={action}>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" className="h-11 sm:h-9">
                Keep selling
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending} className="h-11 sm:h-9">
              <Spinner pending={pending} icon={<Pause aria-hidden="true" />} />
              Pause sales
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// --- Admin ----------------------------------------------------------------------------------

export function AdminApproveButton({ launchId, title }: { launchId: string; title: string }) {
  const [state, action, pending] = useAction(
    () => adminApproveLaunchAction({ launchId }),
    `“${title}” is live.`,
  )
  return (
    <form action={action} className="space-y-2">
      <Button type="submit" disabled={pending} className={fullOnPhone}>
        <Spinner pending={pending} icon={<Rocket aria-hidden="true" />} />
        Approve and go live
      </Button>
      <ErrorText state={state} />
    </form>
  )
}

/** Send a launch in review back to draft, with a note the members read. */
export function AdminRejectButton({ launchId, title }: { launchId: string; title: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(
    async (_previous: Result, formData: FormData): Promise<Result> => {
      const result = await adminRejectLaunchAction({
        launchId,
        note: String(formData.get("note") ?? ""),
      })
      if (result.ok) {
        setOpen(false)
        toast.success("Sent back to the members.")
      }
      return result
    },
    null,
  )
  const noteError = state && !state.ok ? state.fieldErrors?.note?.[0] : undefined
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className={fullOnPhone}>
          <Undo2 aria-hidden="true" />
          Send back
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send “{title}” back for changes?</DialogTitle>
          <DialogDescription>
            The launch goes back to draft and both members get your note. They approve it again once
            they have made the changes.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor={`${id}-note`}>What should they change?</Label>
            <Textarea
              id={`${id}-note`}
              name="note"
              rows={4}
              maxLength={REVIEW_NOTE_MAX}
              required
              aria-invalid={noteError ? true : undefined}
              aria-describedby={noteError ? `${id}-error` : undefined}
              placeholder="The description promises updates for life; please say what buyers get."
            />
            {noteError ? (
              <p id={`${id}-error`} className="text-sm text-destructive">
                {noteError}
              </p>
            ) : null}
          </div>
          {!noteError ? <ErrorText state={state} /> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" className="h-11 sm:h-9">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending} className="h-11 sm:h-9">
              <Spinner pending={pending} icon={<Send aria-hidden="true" />} />
              Send back
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AdminEndButton({ launchId, title }: { launchId: string; title: string }) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(async (): Promise<Result> => {
    const result = await adminEndLaunchAction({ launchId })
    if (result.ok) {
      setOpen(false)
      toast.success("Sales have ended.")
    }
    return result
  }, null)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className={fullOnPhone}>
          <Square aria-hidden="true" />
          End sales
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End sales of “{title}” for good?</DialogTitle>
          <DialogDescription>
            Nobody can buy it any more and this can&apos;t be undone. Buyers keep their access.
          </DialogDescription>
        </DialogHeader>
        <ErrorText state={state} />
        <form action={action}>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" className="h-11 sm:h-9">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={pending} className="h-11 sm:h-9">
              <Spinner pending={pending} icon={<Square aria-hidden="true" />} />
              End sales
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
