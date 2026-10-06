import { cn } from "@/lib/utils"
import { SCORE_BAND_LABELS, scoreBand, scorePercent } from "@/lib/matching/score"

/**
 * A match's score as a percentage ("82%"), coloured by band (great / good / possible fit). The
 * band is spelled out for screen readers; sighted people see it in the "Why this match" panel.
 */
export function ScoreBadge({ score, className }: { score: number; className?: string }) {
  const band = scoreBand(score)
  const percent = scorePercent(score)
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center rounded-full border px-2.5 text-xs font-semibold tabular-nums",
        band === "great" && "border-transparent bg-primary text-primary-foreground",
        band === "good" && "border-transparent bg-secondary text-secondary-foreground",
        band === "fair" && "text-muted-foreground",
        className,
      )}
      aria-label={`${percent}% match, ${SCORE_BAND_LABELS[band].toLowerCase()}`}
      title={SCORE_BAND_LABELS[band]}
    >
      {percent}%
    </span>
  )
}
