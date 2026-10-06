import { ArrowRight, Hammer, Lightbulb, Package, Sparkles, Users } from "lucide-react"
import Link from "next/link"

import { formatPrice } from "@/components/supply/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { TargetType } from "@/lib/db/schema"
import { openMatchFormAction } from "@/lib/matching/actions"
import type { MatchView, TargetCard } from "@/lib/matching/queries"
import { isBuiltRoute } from "@/lib/nav"
import { AVAILABILITY_LABELS, PRODUCT_FORMAT_LABELS } from "@/lib/profiles/fields"
import { PRODUCT_STAGE_LABELS } from "@/lib/products/fields"
import { SIZE_TIER_LABELS } from "@/lib/social/size-tier"

import { FeatureBreakdown } from "./feature-breakdown"
import { MatchCardActions } from "./match-card-actions"
import { MatchCardFrame } from "./match-card-frame"
import { MarkMatchesShown } from "./mark-matches-shown"
import { ScoreBadge } from "./score-badge"

const TYPE_LABELS: Record<TargetType, string> = {
  product: "Product",
  idea: "Brief",
  builder: "Builder",
  creator: "Creator",
}

const TYPE_ICONS = { product: Package, idea: Lightbulb, builder: Hammer, creator: Users }

const PROVIDER_LABELS = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  github: "GitHub",
}

function compactCount(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  )
}

/** Title and a line of facts for each kind of target. */
export function targetSummary(target: TargetCard): {
  title: string
  facts: string[]
  topics: string[]
} {
  switch (target.type) {
    case "product":
      return {
        title: target.title,
        facts: [
          `by ${target.ownerName}`,
          PRODUCT_FORMAT_LABELS[target.format],
          PRODUCT_STAGE_LABELS[target.stage].title,
          formatPrice(target.priceCents, target.currency) ?? "",
        ].filter(Boolean),
        topics: target.topics,
      }
    case "idea":
      return {
        title: target.title,
        facts: [
          `by ${target.ownerName}`,
          target.sizeTier ? `${SIZE_TIER_LABELS[target.sizeTier]} audience` : "",
          PRODUCT_FORMAT_LABELS[target.format],
          formatPrice(target.priceCents, target.currency) ?? "",
        ].filter(Boolean),
        topics: target.topics,
      }
    case "builder":
      return {
        title: target.name,
        facts: [`@${target.handle}`, AVAILABILITY_LABELS[target.availability].title],
        topics: [...target.skills, ...target.stack],
      }
    case "creator":
      return {
        title: target.name,
        facts: [
          `@${target.handle}`,
          target.reach
            ? `${compactCount(target.reach.followers)} on ${PROVIDER_LABELS[target.reach.provider]}`
            : "",
          target.sizeTier ? `${SIZE_TIER_LABELS[target.sizeTier]} audience` : "",
        ].filter(Boolean),
        topics: target.topics,
      }
  }
}

/** Where "Send a proposal" goes (§19.24: `?to=<userId>&idea|product=<id>&match=<matchId>`). */
export function proposalHref(target: TargetCard, matchId: string | null): string {
  const query = new URLSearchParams({ to: target.ownerUserId })
  if (target.type === "product") query.set("product", target.id)
  if (target.type === "idea") query.set("idea", target.id)
  if (matchId) query.set("match", matchId)
  return `/app/proposals/new?${query.toString()}`
}

/**
 * One match on Discover, Saved or the home page: what it is, the score, the one-sentence
 * explanation, "Why this match", and the actions. The title block is a form button that records
 * `match.clicked` and opens the idea, product or profile (works without JavaScript; a prefetch
 * records nothing). Actions are 44 px on touch screens; nothing depends on hover.
 */
export function MatchCard({
  match,
  rank,
  compact = false,
}: {
  match: MatchView
  /** 1-based position in the list the person sees (null when not part of a ranked list). */
  rank: number | null
  /** Home page: no breakdown, no topics. */
  compact?: boolean
}) {
  const { target } = match
  const summary = targetSummary(target)
  const Icon = TYPE_ICONS[target.type]
  const canPropose = target.available && isBuiltRoute("/app/proposals")
  return (
    <MatchCardFrame label={`${TYPE_LABELS[target.type]}: ${summary.title}`}>
      <article className="flex h-full flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs">
        <div className="flex items-start justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Icon className="size-3.5" aria-hidden="true" />
            {TYPE_LABELS[target.type]}
            {!target.available ? (
              <Badge variant="outline" className="ml-1">
                No longer open
              </Badge>
            ) : null}
          </span>
          <ScoreBadge score={match.score} />
        </div>

        <form action={openMatchFormAction}>
          <input type="hidden" name="matchId" value={match.id} />
          {rank !== null ? <input type="hidden" name="rank" value={rank} /> : null}
          <button
            type="submit"
            className="group -m-1 block w-[calc(100%+0.5rem)] rounded-lg p-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className="sr-only">Open </span>
            <span className="block font-semibold text-pretty break-words group-hover:underline">
              {summary.title}
            </span>
            {summary.facts.length > 0 ? (
              <span className="mt-0.5 block text-sm text-muted-foreground">
                {summary.facts.join(" · ")}
              </span>
            ) : null}
          </button>
        </form>

        <p className="flex gap-2 text-sm text-pretty">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <span>{match.explanation}</span>
        </p>

        {!compact && target.type === "idea" && target.excerpt ? (
          <p className="line-clamp-3 text-sm text-muted-foreground">{target.excerpt}</p>
        ) : null}
        {!compact && target.type === "builder" && target.bio ? (
          <p className="line-clamp-3 text-sm text-muted-foreground">{target.bio}</p>
        ) : null}

        {!compact && summary.topics.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Topics">
            {summary.topics.slice(0, 5).map((topic) => (
              <li key={topic}>
                <Badge variant="secondary" className="max-w-full font-normal whitespace-normal">
                  {topic}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}

        {!compact ? <FeatureBreakdown features={match.features} score={match.score} /> : null}

        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <MatchCardActions
            matchId={match.id}
            rank={rank}
            saved={match.status === "saved"}
            title={summary.title}
          />
          {canPropose ? (
            <Button asChild className="h-11 sm:h-9">
              <Link href={proposalHref(target, match.id)}>
                Send a proposal
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </div>
      </article>
    </MatchCardFrame>
  )
}

/** A ranked list of match cards, recording `match.shown` once rendered. */
export function MatchList({
  matches,
  label,
  compact = false,
  startRank = 1,
}: {
  matches: readonly MatchView[]
  label: string
  compact?: boolean
  startRank?: number
}) {
  return (
    <>
      <ul aria-label={label} className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {matches.map((match, index) => (
          <MatchCard key={match.id} match={match} rank={startRank + index} compact={compact} />
        ))}
      </ul>
      <MarkMatchesShown
        items={matches.map((match, index) => ({ matchId: match.id, rank: startRank + index }))}
      />
    </>
  )
}
