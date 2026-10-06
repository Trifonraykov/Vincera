import { ChevronDown } from "lucide-react"

import type { MatchFeatures } from "@/lib/db/schema"
import { MATCH_FEATURES } from "@/lib/db/schema/types"
import { FEATURE_LABELS } from "@/lib/matching/explanation-text"
import { SCORE_BAND_LABELS, scoreBand, scorePercent } from "@/lib/matching/score"

/**
 * "Why this match": the seven §8 features as labelled bars, behind a native disclosure (a tap
 * target on phones, no hover, works without JavaScript). Values are shown as percentages; 50% is
 * neutral (unknown inputs).
 */
export function FeatureBreakdown({ features, score }: { features: MatchFeatures; score: number }) {
  return (
    <details className="group rounded-lg border bg-muted/30 text-sm">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 font-medium select-none sm:min-h-9 [&::-webkit-details-marker]:hidden">
        Why this match
        <ChevronDown
          className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-3 border-t px-3 py-3">
        <p className="text-muted-foreground">
          {SCORE_BAND_LABELS[scoreBand(score)]}: {scorePercent(score)}% overall. 50% on a line means
          we don&apos;t know enough yet.
        </p>
        <dl className="grid gap-2">
          {MATCH_FEATURES.map((feature) => {
            const percent = scorePercent(features[feature])
            return (
              <div key={feature} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
                <dt className="min-w-0 text-pretty">{FEATURE_LABELS[feature]}</dt>
                <dd className="text-right text-xs text-muted-foreground tabular-nums">
                  {percent}%
                </dd>
                <div
                  className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted"
                  aria-hidden="true"
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </div>
            )
          })}
        </dl>
      </div>
    </details>
  )
}
