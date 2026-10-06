import "server-only"

import Link from "next/link"

import { formatDay, formatPrice } from "@/components/supply/format"
import { MarkdownText } from "@/components/supply/markdown-text"
import { TopicList } from "@/components/supply/topic-list"
import type { IdeaRecord } from "@/lib/ideas/queries"
import { PRODUCT_FORMAT_LABELS } from "@/lib/profiles/fields"

/**
 * An idea as others read it (and as its owner sees it once it can't be edited): who posted it,
 * the facts, the topics, then the problem and the audience evidence rendered as sanitized
 * Markdown (§14).
 */
export function IdeaDetails({ idea, showOwner }: { idea: IdeaRecord; showOwner: boolean }) {
  const price = formatPrice(idea.targetPriceCents, idea.currency)
  return (
    <article className="space-y-6">
      <dl className="grid grid-cols-2 gap-4 rounded-xl border p-4 text-sm sm:grid-cols-4">
        {showOwner ? (
          <div className="col-span-2 space-y-1 sm:col-span-1">
            <dt className="text-muted-foreground">Creator</dt>
            <dd className="font-medium break-words">
              <Link href={`/c/${idea.owner.handle}`} className="underline-offset-4 hover:underline">
                {idea.owner.displayName}
              </Link>{" "}
              <span className="text-muted-foreground">@{idea.owner.handle}</span>
            </dd>
          </div>
        ) : null}
        <div className="space-y-1">
          <dt className="text-muted-foreground">Format</dt>
          <dd className="font-medium">{PRODUCT_FORMAT_LABELS[idea.format]}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground">Target price</dt>
          <dd className="font-medium tabular-nums">{price ?? "Not set"}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground">{idea.publishedAt ? "Published" : "Created"}</dt>
          <dd className="font-medium">{formatDay(idea.publishedAt ?? idea.createdAt)}</dd>
        </div>
      </dl>

      <TopicList topics={idea.topics} label="Topics" />

      <section className="space-y-2" aria-labelledby="idea-problem">
        <h2 id="idea-problem" className="text-base font-semibold">
          Problem
        </h2>
        {idea.problem ? (
          <MarkdownText source={idea.problem} />
        ) : (
          <p className="text-sm text-muted-foreground">Not described yet.</p>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="idea-evidence">
        <h2 id="idea-evidence" className="text-base font-semibold">
          Audience evidence
        </h2>
        {idea.audienceEvidence ? (
          <MarkdownText source={idea.audienceEvidence} />
        ) : (
          <p className="text-sm text-muted-foreground">None added.</p>
        )}
      </section>
    </article>
  )
}
