import type { CSSProperties } from "react"

import type { ListingCard } from "@/lib/listings/cards"
import { cn } from "@/lib/utils"

/**
 * The big picture of a listing (CLAUDE.md §19.45), filling its parent (which sets the size):
 * - a tall image (an app screenshot) fills the frame, anchored at the top;
 * - a wide image (a link preview) sits on a blurred, enlarged copy of itself, so nothing is cut;
 * - only an icon: the icon, large, on the listing's generated gradient;
 * - nothing: the generated gradient with the initials.
 * Images are our copies (`/api/products/<id>/media/<hash>`), never the source's own URLs.
 */
export function ListingVisual({
  listing,
  eager = false,
  className,
}: {
  listing: Pick<ListingCard, "title" | "cover" | "icon" | "visual">
  eager?: boolean
  className?: string
}) {
  const { cover, icon, visual } = listing
  const loading = eager ? "eager" : "lazy"
  const gradient: CSSProperties = { backgroundImage: visual.gradient }

  if (cover) {
    const wide = cover.width !== null && cover.height !== null && cover.width > cover.height
    if (!wide) {
      return (
        // eslint-disable-next-line @next/next/no-img-element -- our own redirecting media route
        <img
          src={cover.url}
          alt=""
          loading={loading}
          decoding="async"
          className={cn("absolute inset-0 size-full object-cover object-top", className)}
          style={gradient}
        />
      )
    }
    return (
      <div className={cn("absolute inset-0 overflow-hidden", className)} style={gradient}>
        {/* eslint-disable-next-line @next/next/no-img-element -- decorative blurred backdrop */}
        <img
          src={cover.url}
          alt=""
          aria-hidden="true"
          loading={loading}
          className="absolute inset-0 size-full scale-125 object-cover opacity-70 blur-2xl"
        />
        {/* eslint-disable-next-line @next/next/no-img-element -- our own redirecting media route */}
        <img
          src={cover.url}
          alt=""
          loading={loading}
          decoding="async"
          className="absolute inset-x-4 top-[12%] mx-auto max-h-[58%] w-[calc(100%-2rem)] rounded-2xl object-contain shadow-2xl ring-1 ring-white/20"
        />
      </div>
    )
  }

  return (
    <div
      className={cn("absolute inset-0 flex items-center justify-center", className)}
      style={gradient}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),transparent_55%)]"
      />
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element -- our own redirecting media route
        <img
          src={icon.url}
          alt=""
          loading={loading}
          className="relative size-32 -translate-y-8 rounded-[28%] shadow-2xl ring-1 ring-white/30"
        />
      ) : (
        <span
          aria-hidden="true"
          className="relative -translate-y-8 text-7xl font-semibold tracking-tight text-white/90 drop-shadow-sm"
        >
          {visual.initials}
        </span>
      )}
    </div>
  )
}

/** The listing's app icon (or its initials on the gradient), as a rounded square. */
export function ListingIcon({
  listing,
  className,
}: {
  listing: Pick<ListingCard, "icon" | "visual">
  className?: string
}) {
  if (listing.icon) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- our own redirecting media route
      <img
        src={listing.icon.url}
        alt=""
        loading="lazy"
        className={cn("size-12 shrink-0 rounded-[24%] ring-1 ring-white/25", className)}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-12 shrink-0 items-center justify-center rounded-[24%] text-base font-semibold text-white ring-1 ring-white/25",
        className,
      )}
      style={{ backgroundImage: listing.visual.gradient }}
    >
      {listing.visual.initials}
    </span>
  )
}
