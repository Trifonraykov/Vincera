"use client"

import { Loader2 } from "lucide-react"
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
import { cn } from "@/lib/utils"

/**
 * Building blocks for the admin's one-click actions (Phase 6): a form button, and a button that
 * asks for confirmation in a dialog first. Both work before hydration finishes (plain forms), show
 * a refusal next to the button, and toast on success. The page re-renders through the action's
 * `revalidatePath`.
 */

export type Result = ActionResult<unknown> | null

export const fullOnPhone = "h-11 w-full sm:h-9 sm:w-auto"

export function ErrorText({ state, className }: { state: Result; className?: string }) {
  if (!state || state.ok) return null
  return (
    <p role="alert" className={cn("text-sm text-destructive", className)}>
      {state.error}
    </p>
  )
}

export function Spinner({ pending, icon }: { pending: boolean; icon?: ReactNode }) {
  return pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : (icon ?? null)
}

export function ActionButton({
  run,
  label,
  icon,
  success,
  variant = "default",
}: {
  run: () => Promise<ActionResult<unknown>>
  label: string
  icon?: ReactNode
  success?: string
  variant?: "default" | "outline" | "secondary" | "destructive" | "ghost"
}) {
  const [state, action, pending] = useActionState(async (): Promise<Result> => {
    const result = await run()
    if (result.ok && success) toast.success(success)
    return result
  }, null)
  return (
    <form action={action} className="space-y-2">
      <Button type="submit" variant={variant} disabled={pending} className={fullOnPhone}>
        <Spinner pending={pending} icon={icon} />
        {label}
      </Button>
      <ErrorText state={state} />
    </form>
  )
}

export function ConfirmButton({
  run,
  label,
  icon,
  title,
  description,
  confirmLabel,
  success,
  variant = "outline",
  confirmVariant = "default",
}: {
  run: () => Promise<ActionResult<unknown>>
  label: string
  icon?: ReactNode
  title: string
  description: ReactNode
  confirmLabel: string
  success?: string
  variant?: "default" | "outline" | "destructive"
  confirmVariant?: "default" | "destructive"
}) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(async (): Promise<Result> => {
    const result = await run()
    if (result.ok) {
      setOpen(false)
      if (success) toast.success(success)
    }
    return result
  }, null)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} className={fullOnPhone}>
          {icon}
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ErrorText state={state} />
        <form action={action}>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" className="h-11 sm:h-9">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant={confirmVariant}
              disabled={pending}
              className="h-11 sm:h-9"
            >
              <Spinner pending={pending} icon={icon} />
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
