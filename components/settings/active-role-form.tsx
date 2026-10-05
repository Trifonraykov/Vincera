"use client"

import { Check, Hammer, Loader2, Megaphone, type LucideIcon } from "lucide-react"
import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"
import { ROLE_LABELS, type AppRole } from "@/lib/nav"
import { switchActiveRole } from "@/lib/users/actions"
import { cn } from "@/lib/utils"

const ROLE_ICONS: Record<AppRole, LucideIcon> = { creator: Megaphone, builder: Hammer }

const ROLE_HINTS: Record<AppRole, string> = {
  creator: "Your home shows your audience, ideas and launches.",
  builder: "Your home shows your products, briefs and builds.",
}

/**
 * Settings → Account: which of your roles the app acts as (§12 `active_role`; the sidebar's role
 * switcher does the same). One row per role; the inactive one has a switch button.
 */
export function ActiveRoleForm({
  roles,
  activeRole,
}: {
  roles: readonly AppRole[]
  activeRole: AppRole | null
}) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<unknown> | null, formData: FormData) =>
      switchActiveRole(formData),
    null,
  )

  return (
    <div className="space-y-3">
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Your roles">
        {roles.map((role) => {
          const Icon = ROLE_ICONS[role]
          const active = role === activeRole
          return (
            <li
              key={role}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-3",
                active && "border-primary ring-2 ring-primary/20",
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
                <Icon className="size-4 text-primary" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{ROLE_LABELS[role]}</span>
                <span className="block text-xs text-muted-foreground">{ROLE_HINTS[role]}</span>
              </span>
              {active ? (
                <span className="inline-flex items-center gap-1 text-sm font-medium">
                  <Check className="size-4" aria-hidden="true" />
                  Active
                </span>
              ) : (
                <form action={formAction}>
                  <input type="hidden" name="role" value={role} />
                  <Button type="submit" variant="outline" size="sm" disabled={pending}>
                    {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                    Use as {ROLE_LABELS[role].toLowerCase()}
                  </Button>
                </form>
              )}
            </li>
          )
        })}
      </ul>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </div>
  )
}
