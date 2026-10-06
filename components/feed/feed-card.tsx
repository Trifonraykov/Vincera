import { Star } from "lucide-react"
import Link from "next/link"

import { formatCount, formatRating, type ListingCard } from "@/lib/listings/cards"

import { HeartButton } from "./heart-button"
import { ListingIcon, ListingVisual } from "./listing-visual"

/**
 * One card of the creator feed (CLAUDE.md §19.45): the picture fills the card, and a soft shade at
 * the bottom carries the few things worth reading: icon, name, one line, @builder, one tag and the
 * rating. The whole card opens the listing; the heart saves it.
 */
export function FeedCard({
  listing,
  saved,
  rank,
  eager = false,
}: {
  listing: ListingCard
  saved: boolean
  rank: number
  eager?: boolean
}) {
  return (
    <article
      aria-label={listing.title}
      className="relative isolate aspect-[4/5] w-full overflow-hidden rounded-[28px] bg-muted shadow-sm ring-1 ring-black/5 dark:ring-white/10"
      data-feed-card
    >
      <ListingVisual listing={listing} eager={eager} />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/85 via-black/45 to-transparent"
      />
      <Link
        href={`/app/feed/${listing.id}?rank=${rank}`}
        className="absolute inset-0 z-10 rounded-[28px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="sr-only">Open {listing.title}</span>
      </Link>
      <HeartButton
        productId={listing.id}
        title={listing.title}
        saved={saved}
        rank={rank}
        className="absolute top-3 right-3 z-20"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 space-y-3 p-5 text-white">
        <div className="flex items-center gap-3">
          <ListingIcon listing={listing} />
          <div className="min-w-0">
            <h2 className="truncate text-lg leading-tight font-semibold">{listing.title}</h2>
            <p className="truncate text-sm text-white/75">@{listing.builder.handle}</p>
          </div>
        </div>
        {listing.hook ? (
          <p className="line-clamp-2 text-[15px] leading-snug text-pretty text-white/90">
            {listing.hook}
          </p>
        ) : null}
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-full bg-white/15 px-2.5 py-1 font-medium backdrop-blur-md">
            {listing.tag}
          </span>
          {listing.rating !== null ? (
            <span className="inline-flex items-center gap-1 text-white/85">
              <Star aria-hidden="true" className="size-3.5 fill-amber-300 text-amber-300" />
              {formatRating(listing.rating)}
              {listing.ratingCount ? (
                <span className="text-white/60">({formatCount(listing.ratingCount)})</span>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </article>
  )
}
