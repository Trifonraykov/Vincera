"use client"

import { CircleAlert, Hammer, Layers, Loader2, Megaphone, type LucideIcon } from "lucide-react"
import { useActionState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"
import { chooseRoles } from "@/lib/onboarding/actions"
import type { RoleChoice } from "@/lib/onboarding/role-choices"

const OPTIONS: { value: RoleChoice; title: string; description: string; icon: LucideIcon }[] = [
  {
    value: "creator",
    title: "I'm a creator",
    description:
      "You have an audience on YouTube, Instagram or TikTok and know what they would pay for.",
    icon: Megaphone,
  },
  {
    value: "builder",
    title: "I'm a builder",
    description:
      "You build tools, templates, apps or AI utilities and want people to sell them to.",
    icon: Hammer,
  },
  {
    value: "both",
    title: "Both",
    description: "You create and you build. Switch between the two from the sidebar any time.",
    icon: Layers,
  },
]

export function RoleForm() {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<unknown> | null, formData: FormData) => chooseRoles(formData),
    null,
  )
  const error = state && !state.ok ? state : null
  const choiceError = error?.fieldErrors?.choice?.[0]

  return (
    <form action={formAction} className="space-y-6">
      {error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{choiceError ?? error.error}</AlertDescription>
        </Alert>
      ) : null}

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="sr-only">Your role</legend>
        {OPTIONS.map(({ value, title, description, icon: Icon }) => (
          <label
            key={value}
            className="relative flex cursor-pointer flex-col gap-3 rounded-xl border bg-card p-5 shadow-xs transition-colors hover:bg-accent/50 has-[:checked]:border-primary has-[:checked]:ring-2 has-[:checked]:ring-primary/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          >
            <input type="radio" name="choice" value={value} className="peer sr-only" required />
            <Icon className="size-6 text-primary" aria-hidden="true" />
            <span className="font-medium">{title}</span>
            <span className="text-sm text-muted-foreground">{description}</span>
          </label>
        ))}
      </fieldset>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Continue
        </Button>
      </div>
    </form>
  )
}
