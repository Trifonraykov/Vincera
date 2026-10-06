import type { ListingCard } from "@/lib/listings/cards"

import { ListingVisual } from "./listing-visual"

/**
 * The detail view's pictures (CLAUDE.md §19.45): a sideways-scrolling row that snaps to each
 * screenshot, edge to edge on phones. Without pictures, the generated cover.
 */
export function ScreenshotCarousel({ listing }: { listing: ListingCard }) {
  if (listing.screenshots.length === 0) {
    return (
      <div className="relative -mx-4 aspect-[4/3] overflow-hidden sm:mx-0 sm:rounded-[28px]">
        <ListingVisual listing={listing} eager />
      </div>
    )
  }
  return (
    <div
      className="-mx-4 flex snap-x snap-mandatory [scrollbar-width:none] gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1 sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
      aria-label={`Screenshots of ${listing.title}`}
      role="region"
      tabIndex={0}
    >
      {listing.screenshots.map((shot, index) => {
        const wide = shot.width !== null && shot.height !== null && shot.width > shot.height
        return (
          // eslint-disable-next-line @next/next/no-img-element -- our own redirecting media route
          <img
            key={shot.url}
            src={shot.url}
            alt={`${listing.title}, picture ${index + 1} of ${listing.screenshots.length}`}
            loading={index < 2 ? "eager" : "lazy"}
            className={
              wide
                ? "h-56 w-auto max-w-[88%] shrink-0 snap-center rounded-3xl object-cover ring-1 ring-black/5 sm:h-72 dark:ring-white/10"
                : "h-[min(50vh,30rem)] w-auto shrink-0 snap-center rounded-3xl object-cover ring-1 ring-black/5 dark:ring-white/10"
            }
            style={{
              aspectRatio: shot.width && shot.height ? `${shot.width} / ${shot.height}` : undefined,
              backgroundImage: listing.visual.gradient,
            }}
          />
        )
      })}
    </div>
  )
}
