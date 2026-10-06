import { conversion, formatRate } from "@/lib/analytics/range"

export type FunnelStep = { label: string; value: number; note?: string }

/**
 * The funnel as a ranked bar list: each step's count, its bar against the largest step, and its
 * conversion from the previous step. A real list, so screen readers get every number; one hue.
 */
export function FunnelSteps({ steps }: { steps: readonly FunnelStep[] }) {
  const max = Math.max(0, ...steps.map((step) => step.value))
  return (
    <ol className="space-y-3" aria-label="Funnel">
      {steps.map((step, index) => {
        const previous = index > 0 ? steps[index - 1] : undefined
        const rate = previous ? conversion(step.value, previous.value) : null
        return (
          <li key={step.label} className="space-y-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="font-medium">{step.label}</span>
              <span className="tabular-nums">
                <span className="font-semibold">{step.value.toLocaleString("en-US")}</span>
                {previous ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {formatRate(rate)} of {previous.label.toLowerCase()}
                  </span>
                ) : null}
              </span>
            </div>
            <div className="h-3 rounded-r-[4px] bg-muted" aria-hidden="true">
              <div
                className="h-full rounded-r-[4px] bg-[#2a78d6] dark:bg-[#3987e5]"
                style={{
                  width:
                    max > 0
                      ? `${Math.max((step.value / max) * 100, step.value > 0 ? 1 : 0)}%`
                      : "0",
                }}
              />
            </div>
            {step.note ? <p className="text-xs text-muted-foreground">{step.note}</p> : null}
          </li>
        )
      })}
    </ol>
  )
}
