import Link from "next/link"

import { ListingIcon, ListingVisual } from "@/components/feed/listing-visual"
import type { ListingCard } from "@/lib/listings/cards"

/**
 * A builder's listings as a grid of pictures (CLAUDE.md §19.45): two across on phones, three from
 * `sm`, each tile the listing's picture with its icon and name. Tiles open the listing in the feed
 * (signed-in creators), so the public page itself stays static.
 */
export function ListingGrid({ listings }: { listings: readonly ListingCard[] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {listings.map((listing, index) => (
        <li key={listing.id}>
          <Link
            href={`/app/feed/${listing.id}`}
            className="group relative block aspect-[4/5] overflow-hidden rounded-3xl ring-1 ring-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:ring-white/10"
          >
            <ListingVisual
              listing={listing}
              eager={index < 4}
              className="transition-transform duration-300 group-hover:scale-[1.03]"
            />
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 to-transparent"
            />
            <span className="absolute inset-x-0 bottom-0 flex items-center gap-2 p-3 text-white">
              <ListingIcon listing={listing} className="size-8" />
              <span className="line-clamp-2 text-sm leading-tight font-medium">
                {listing.title}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
