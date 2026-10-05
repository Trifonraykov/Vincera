import { Check, Clock } from "lucide-react"
import Link from "next/link"

import type { OnboardingProgress as Progress } from "@/lib/onboarding/next-step"
import { cn } from "@/lib/utils"

/**
 * Progress indicator for onboarding pages (§16 Phase 1): "Step 2 of 5", a segmented bar on small
 * screens and the labelled steps from `sm` up. Completed steps link back to their page.
 * Pass `progress` from `requireOnboardingStep(step)` (lib/onboarding/page.ts).
 */
export function OnboardingProgress({
  progress,
  className,
}: {
  progress: Progress
  className?: string
}) {
  const current = progress.steps[progress.currentIndex]

  return (
    <nav aria-label="Onboarding progress" className={cn("space-y-3", className)}>
      {current ? (
        <p className="text-sm text-muted-foreground">
          Step {progress.currentIndex + 1} of {progress.total}
          <span className="sr-only">: {current.label}</span>
        </p>
      ) : null}

      <div className="flex gap-1.5 sm:hidden" aria-hidden="true">
        {progress.steps.map((step) => (
          <span
            key={step.id}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              step.current ? "bg-primary" : step.state === "pending" ? "bg-muted" : "bg-primary/40",
            )}
          />
        ))}
      </div>

      <ol className="hidden flex-wrap gap-x-4 gap-y-2 text-sm sm:flex">
        {progress.steps.map((step, index) => {
          const complete = step.state !== "pending"
          const marker = (
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium",
                step.current && "border-primary bg-primary text-primary-foreground",
                !step.current && complete && "border-primary/40 bg-primary/10 text-primary",
                !step.current && !complete && "text-muted-foreground",
              )}
              aria-hidden="true"
            >
              {complete && !step.current ? (
                step.state === "skipped" ? (
                  <Clock className="size-3" />
                ) : (
                  <Check className="size-3" />
                )
              ) : (
                index + 1
              )}
            </span>
          )
          const status = step.current
            ? ""
            : step.state === "done"
              ? " (done)"
              : step.state === "skipped"
                ? " (skipped for now)"
                : ""
          const label = (
            <>
              {marker}
              <span>{step.label}</span>
              {status ? <span className="sr-only">{status}</span> : null}
            </>
          )

          return (
            <li key={step.id} className="flex items-center">
              {complete && !step.current ? (
                <Link
                  href={step.href}
                  className="flex items-center gap-2 rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {label}
                </Link>
              ) : (
                <span
                  className={cn(
                    "flex items-center gap-2",
                    step.current ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                  aria-current={step.current ? "step" : undefined}
                >
                  {label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
