import { ExternalLink, Rocket } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { PRODUCT_FORMAT_LABELS } from "@/lib/profiles/fields"
import type { PublicPortfolioItem } from "@/lib/public-profiles/load"

/** A builder's portfolio on their public profile (titles, links, descriptions). */
export function PortfolioList({ items }: { items: readonly PublicPortfolioItem[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`} className="space-y-2 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{item.title}</h3>
            {item.isShipped ? (
              <Badge variant="secondary">
                <Rocket aria-hidden="true" />
                Shipped
              </Badge>
            ) : null}
            {item.format ? (
              <Badge variant="outline">{PRODUCT_FORMAT_LABELS[item.format]}</Badge>
            ) : null}
          </div>
          {item.description ? (
            <p className="text-sm text-pretty text-muted-foreground">{item.description}</p>
          ) : null}
          {item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer nofollow ugc"
              className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
            >
              Visit
              <ExternalLink className="size-3.5" aria-hidden="true" />
              <span className="sr-only">{item.title} (opens in a new tab)</span>
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
