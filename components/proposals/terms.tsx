import { ArrowRight, CalendarClock, PieChart } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  formatExact,
  formatRelative,
  revisionChanges,
  type RevisionChange,
  type RevisionTerms,
} from "@/lib/proposals/display"
import { formatTimeline } from "@/lib/proposals/fields"
import type { PartyInfo, ProposalRevisionRow } from "@/lib/proposals/queries"
import { cn } from "@/lib/utils"

/**
 * The terms of an offer and the history of offers on a proposal (§12 `/app/proposals/[id]`):
 * who proposed what, with what each counter-offer changed highlighted (and said in words, for
 * screen readers and in black and white).
 */

const CHANGED = "rounded-md bg-amber-500/10 ring-1 ring-amber-500/40 dark:bg-amber-400/10"

function ChangedLabel({ was }: { was: string }) {
  return (
    <span className="ml-1 text-xs font-normal text-muted-foreground">
      <span className="sr-only">changed, </span>was {was}
    </span>
  )
}

/** Split, timeline and scope of one offer; `previous` highlights what changed since it. */
export function TermsList({
  terms,
  previous = null,
  className,
}: {
  terms: RevisionTerms
  previous?: RevisionTerms | null
  className?: string
}) {
  const changes = new Set<RevisionChange>(revisionChanges(previous, terms))
  return (
    <dl className={cn("grid gap-3 text-sm", className)}>
      <div className={cn("flex items-start gap-3 p-2", changes.has("split") && CHANGED)}>
        <PieChart className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <dt className="text-muted-foreground">Split</dt>
          <dd className="font-medium tabular-nums">
            Creator {terms.creatorSplitPct}% · Builder {terms.builderSplitPct}%
            {changes.has("split") && previous ? (
              <ChangedLabel was={`${previous.creatorSplitPct}% / ${previous.builderSplitPct}%`} />
            ) : null}
          </dd>
        </div>
      </div>
      <div className={cn("flex items-start gap-3 p-2", changes.has("timelineWeeks") && CHANGED)}>
        <CalendarClock
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <dt className="text-muted-foreground">Timeline</dt>
          <dd className="font-medium">
            {formatTimeline(terms.timelineWeeks)}
            {changes.has("timelineWeeks") && previous ? (
              <ChangedLabel was={formatTimeline(previous.timelineWeeks)} />
            ) : null}
          </dd>
        </div>
      </div>
      <div className={cn("p-2", changes.has("scope") && CHANGED)}>
        <dt className="text-muted-foreground">
          Scope
          {changes.has("scope") ? (
            <Badge variant="outline" className="ml-2 align-middle">
              Changed
            </Badge>
          ) : null}
        </dt>
        <dd className="mt-1 break-words whitespace-pre-wrap">{terms.scope}</dd>
      </div>
    </dl>
  )
}

/** Every offer on the proposal, newest first, each compared with the one before it. */
export function RevisionHistory({
  revisions,
  parties,
  viewerId,
  now,
}: {
  revisions: readonly ProposalRevisionRow[]
  parties: ReadonlyMap<string, PartyInfo>
  viewerId: string
  now: Date
}) {
  const entries = revisions.map((revision, index) => ({
    revision,
    previous: index > 0 ? (revisions[index - 1] ?? null) : null,
  }))
  return (
    <ol className="space-y-4" aria-label="Offers, newest first">
      {entries.reverse().map(({ revision, previous }, index) => {
        const author = parties.get(revision.authorUserId)
        const byViewer = revision.authorUserId === viewerId
        return (
          <li key={revision.id} className="rounded-xl border bg-card p-4 shadow-xs">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium">
                {revision.revisionNumber === 1 ? "First offer" : `Counter-offer`}
              </span>
              <span className="text-muted-foreground">
                by {byViewer ? "you" : (author?.name ?? "the other party")}
                {author ? ` (${author.role})` : null}
              </span>
              <time
                dateTime={revision.createdAt.toISOString()}
                title={formatExact(revision.createdAt)}
                className="text-muted-foreground"
              >
                · {formatRelative(revision.createdAt, now)}
              </time>
              {index === 0 ? <Badge variant="secondary">On the table</Badge> : null}
            </div>
            {previous ? (
              <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                Offer {previous.revisionNumber} <ArrowRight className="size-3" aria-hidden="true" />{" "}
                offer {revision.revisionNumber}
              </p>
            ) : null}
            <TermsList terms={revision} previous={previous} className="mt-3" />
            {revision.message ? (
              <blockquote className="mt-3 border-l-2 pl-3 text-sm break-words whitespace-pre-wrap text-muted-foreground">
                {revision.message}
              </blockquote>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
