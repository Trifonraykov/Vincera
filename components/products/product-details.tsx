import "server-only"

import { ExternalLink } from "lucide-react"
import Link from "next/link"

import { formatDay, formatPrice } from "@/components/supply/format"
import { MarkdownText } from "@/components/supply/markdown-text"
import { TopicList } from "@/components/supply/topic-list"
import { PRODUCT_STAGE_LABELS } from "@/lib/products/fields"
import type { ProductRecord } from "@/lib/products/queries"
import { PRODUCT_FORMAT_LABELS } from "@/lib/profiles/fields"

/**
 * A product as others read it (and as its owner sees it once it can't be edited): who builds it,
 * the facts, the topics and the description rendered as sanitized Markdown (§14). The demo link
 * is http(s) only (checked on save and by the database).
 */
export function ProductDetails({
  product,
  showOwner,
}: {
  product: ProductRecord
  showOwner: boolean
}) {
  const price = formatPrice(product.targetPriceCents, product.currency)
  return (
    <article className="space-y-6">
      <dl className="grid grid-cols-2 gap-4 rounded-xl border p-4 text-sm sm:grid-cols-4">
        {showOwner ? (
          <div className="col-span-2 space-y-1 sm:col-span-4">
            <dt className="text-muted-foreground">Builder</dt>
            <dd className="font-medium break-words">
              <Link
                href={`/b/${product.owner.handle}`}
                className="underline-offset-4 hover:underline"
              >
                {product.owner.displayName}
              </Link>{" "}
              <span className="text-muted-foreground">@{product.owner.handle}</span>
            </dd>
          </div>
        ) : null}
        <div className="space-y-1">
          <dt className="text-muted-foreground">Stage</dt>
          <dd className="font-medium">{PRODUCT_STAGE_LABELS[product.stage].title}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground">Format</dt>
          <dd className="font-medium">{PRODUCT_FORMAT_LABELS[product.format]}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground">Planned price</dt>
          <dd className="font-medium tabular-nums">{price ?? "Not set"}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground">Builder&apos;s share</dt>
          <dd className="font-medium tabular-nums">
            {product.preferredSplitBuilderPct === null
              ? "Open to talk"
              : `${product.preferredSplitBuilderPct}%`}
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground">Collabs</dt>
          <dd className="font-medium">
            {product.exclusivity ? "One creator at a time" : "Several creators"}
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground">{product.publishedAt ? "Published" : "Created"}</dt>
          <dd className="font-medium">{formatDay(product.publishedAt ?? product.createdAt)}</dd>
        </div>
        {product.targetUser ? (
          <div className="col-span-2 space-y-1">
            <dt className="text-muted-foreground">Who it&apos;s for</dt>
            <dd className="font-medium break-words">{product.targetUser}</dd>
          </div>
        ) : null}
      </dl>

      {product.demoUrl ? (
        <a
          href={product.demoUrl}
          target="_blank"
          rel="nofollow noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-2 text-sm font-medium break-all underline-offset-4 hover:underline"
        >
          <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
          Open the demo
        </a>
      ) : null}

      <TopicList topics={product.topics} label="Topics" />

      <section className="space-y-2" aria-labelledby="product-description">
        <h2 id="product-description" className="text-base font-semibold">
          Description
        </h2>
        {product.description ? (
          <MarkdownText source={product.description} />
        ) : (
          <p className="text-sm text-muted-foreground">Not described yet.</p>
        )}
      </section>
    </article>
  )
}
