import { ExternalLink, Rocket } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { PRODUCT_FORMAT_LABELS } from "@/lib/profiles/fields"
import type { PublicPortfolioItem } from "@/lib/public-profiles/load"

/** A builder's portfolio on their public profile (images, titles, links, descriptions). */
export function PortfolioList({ items }: { items: readonly PublicPortfolioItem[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {items.map((item, index) => (
        <li
          key={`${item.title}-${index}`}
          className="space-y-2 overflow-hidden rounded-xl border bg-card p-4"
        >
          {item.imageSrc ? (
            // Redirects to a short-lived signed URL (lib/profiles/portfolio-image.ts), which
            // next/image would need every storage host configured for.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.imageSrc}
              alt={`${item.title}: project image`}
              loading="lazy"
              decoding="async"
              className="-mx-4 -mt-4 mb-3 aspect-[16/9] w-[calc(100%+2rem)] max-w-none border-b bg-muted object-cover"
            />
          ) : null}
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
