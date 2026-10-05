"use client"

import {
  Check,
  CircleAlert,
  Hammer,
  Layers,
  Loader2,
  Megaphone,
  type LucideIcon,
} from "lucide-react"
import { useActionState, useId } from "react"

import { FormActions } from "@/components/profiles/form-kit"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"
import { chooseRoles } from "@/lib/onboarding/actions"
import type { AppRole } from "@/lib/nav"
import type { RoleChoice } from "@/lib/onboarding/role-choices"
import { cn } from "@/lib/utils"

const OPTIONS: {
  value: RoleChoice
  title: string
  description: string
  points: string[]
  icon: LucideIcon
}[] = [
  {
    value: "creator",
    title: "I'm a creator",
    description:
      "You have an audience on YouTube, Instagram or TikTok and know what they would pay for.",
    points: [
      "Connect your channels to show your reach",
      "Post ideas your audience keeps asking for",
      "Promote what you launch and share every sale",
    ],
    icon: Megaphone,
  },
  {
    value: "builder",
    title: "I'm a builder",
    description:
      "You build tools, templates, apps or AI utilities and want people to sell them to.",
    points: [
      "Show your projects and GitHub",
      "List products that need an audience",
      "Build with creators for a share of the revenue",
    ],
    icon: Hammer,
  },
  {
    value: "both",
    title: "Both",
    description: "You create and you build. Set up each side and switch between them any time.",
    points: ["Creator steps first, then builder", "One handle can serve both profiles"],
    icon: Layers,
  },
]

/**
 * Creator, builder or both (§12). Roles are only ever added: options the user already has are
 * shown as such and cannot be picked again.
 */
export function RoleForm({ currentRoles = [] }: { currentRoles?: readonly AppRole[] }) {
  const has = (value: RoleChoice) =>
    value === "both"
      ? currentRoles.includes("creator") && currentRoles.includes("builder")
      : currentRoles.includes(value)
  const id = useId()
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
        {OPTIONS.map(({ value, title, description, points, icon: Icon }) => {
          const already = has(value)
          return (
            <label
              key={value}
              className={cn(
                "group relative flex flex-col gap-3 rounded-xl border bg-card p-5 shadow-xs transition-colors has-[:checked]:border-primary has-[:checked]:ring-2 has-[:checked]:ring-primary/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                already ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-accent/50",
              )}
            >
              <input
                type="radio"
                name="choice"
                value={value}
                className="sr-only"
                required
                disabled={already}
                aria-labelledby={`${id}-${value}-title`}
                aria-describedby={`${id}-${value}-details`}
              />
              <span className="flex items-center justify-between gap-2">
                <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                  <Icon className="size-5 text-primary" aria-hidden="true" />
                </span>
                <span
                  className="flex size-5 items-center justify-center rounded-full border group-has-[:checked]:border-primary"
                  aria-hidden="true"
                >
                  <span className="hidden size-2.5 rounded-full bg-primary group-has-[:checked]:block" />
                </span>
              </span>
              <span id={`${id}-${value}-title`} className="text-base font-medium">
                {title}
              </span>
              <span id={`${id}-${value}-details`} className="flex flex-col gap-3">
                <span className="text-sm text-muted-foreground">{description}</span>
                <span className="flex flex-col gap-1.5 text-sm">
                  {points.map((point) => (
                    <span key={point} className="flex gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                      <span>{point}</span>
                    </span>
                  ))}
                </span>
              </span>
              {already ? (
                <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-foreground">
                  <Check className="size-4" aria-hidden="true" />
                  {value === "both" ? "You have both roles" : "Your current role"}
                </span>
              ) : null}
            </label>
          )
        })}
      </fieldset>

      <FormActions>
        <p className="text-sm text-muted-foreground sm:mr-auto">
          Roles can be added later, never taken away.
        </p>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Continue
        </Button>
      </FormActions>
    </form>
  )
}
