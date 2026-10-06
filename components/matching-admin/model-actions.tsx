"use client"

import { Brain, Loader2, Power, PowerOff } from "lucide-react"
import { useActionState, useState, type ReactNode } from "react"
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
import type { ActionResult } from "@/lib/actions/result"
import {
  activateMatchingModelAction,
  deactivateMatchingModelAction,
  trainMatchingModelAction,
} from "@/lib/matching/v1/actions"
import { cn } from "@/lib/utils"

/**
 * `/admin/matching` controls (CLAUDE.md §19.42): train a v1 model, activate or deactivate a
 * version. Small forms (they work before hydration); refusals show next to the button; the page
 * re-renders after the action (`revalidatePath`). Activation asks for confirmation first.
 */

type Result = ActionResult<unknown> | null

const fullOnPhone = "h-11 w-full sm:h-9 sm:w-auto"

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

export function TrainModelButton() {
  const [state, action, pending] = useActionState(async (): Promise<Result> => {
    const result = await trainMatchingModelAction({})
    if (result.ok) toast.success(`Trained ${result.data.modelVersion}. It is not active yet.`)
    return result
  }, null)
  return (
    <form action={action} className="space-y-2">
      <Button type="submit" disabled={pending} className={fullOnPhone}>
        <Spinner pending={pending} icon={<Brain aria-hidden="true" />} />
        Train a v1 model
      </Button>
      <ErrorText state={state} />
    </form>
  )
}

export function ModelSwitchButton({
  modelVersion,
  mode,
  gateNote,
}: {
  modelVersion: string
  mode: "activate" | "deactivate"
  /** Shown in the dialog when the version will not rank yet (the §8 launch gate). */
  gateNote: string | null
}) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(async (): Promise<Result> => {
    const result =
      mode === "activate"
        ? await activateMatchingModelAction({ modelVersion })
        : await deactivateMatchingModelAction({ modelVersion })
    if (result.ok) {
      setOpen(false)
      toast.success(mode === "activate" ? `${modelVersion} is now active.` : "v0 is active again.")
    }
    return result
  }, null)
  const title = mode === "activate" ? `Activate ${modelVersion}?` : `Deactivate ${modelVersion}?`
  return (
    <div className="space-y-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant={mode === "activate" ? "default" : "outline"}
            className={fullOnPhone}
            disabled={pending}
          >
            <Spinner
              pending={pending}
              icon={
                mode === "activate" ? <Power aria-hidden="true" /> : <PowerOff aria-hidden="true" />
              }
            />
            {mode === "activate" ? "Activate" : "Deactivate"}
            <span className="sr-only"> {modelVersion}</span>
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {mode === "activate"
                ? "Everyone's match lists are recomputed with this version. The change is written to the audit log."
                : "v0 becomes the active version again and everyone's match lists are recomputed. The change is written to the audit log."}
            </DialogDescription>
          </DialogHeader>
          {mode === "activate" && gateNote ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              {gateNote}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" className={fullOnPhone}>
                Cancel
              </Button>
            </DialogClose>
            <form action={action}>
              <Button type="submit" disabled={pending} className={fullOnPhone}>
                <Spinner pending={pending} icon={null} />
                {mode === "activate" ? "Activate" : "Deactivate"}
              </Button>
            </form>
          </DialogFooter>
          <ErrorText state={state} />
        </DialogContent>
      </Dialog>
    </div>
  )
}
