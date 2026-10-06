import { ArrowRight, Lightbulb } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { IdeaCard } from "@/lib/matching/queries"
import { isBuiltRoute } from "@/lib/nav"

import { proposalHref, targetSummary } from "./match-card"

/**
 * An open brief that is not in the builder's ranked matches ("More open briefs"): no score, a
 * plain link to the idea, and "Send a proposal".
 */
export function BriefCard({ idea }: { idea: IdeaCard }) {
  const summary = targetSummary(idea)
  return (
    <li className="list-none">
      <article className="flex h-full flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Lightbulb className="size-3.5" aria-hidden="true" />
          Brief
        </span>
        <Link
          href={idea.href}
          className="-m-1 block rounded-lg p-1 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="block font-semibold text-pretty break-words">{summary.title}</span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            {summary.facts.join(" · ")}
          </span>
        </Link>
        {idea.excerpt ? (
          <p className="line-clamp-3 text-sm text-muted-foreground">{idea.excerpt}</p>
        ) : null}
        {summary.topics.length > 0 ? (
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
        {isBuiltRoute("/app/proposals") ? (
          <div className="mt-auto flex justify-end border-t pt-3">
            <Button asChild variant="outline" className="h-11 sm:h-9">
              <Link href={proposalHref(idea, null)}>
                Send a proposal
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </div>
        ) : null}
      </article>
    </li>
  )
}
