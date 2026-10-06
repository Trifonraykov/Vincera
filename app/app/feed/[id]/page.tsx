import { BadgeCheck, ExternalLink, Send, ShieldQuestion, Star } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { HeartButton } from "@/components/feed/heart-button"
import { ListingIcon } from "@/components/feed/listing-visual"
import { RecordListingOpen } from "@/components/feed/record-open"
import { ScreenshotCarousel } from "@/components/feed/screenshot-carousel"
import { AppBarSlot } from "@/components/layout/app-bar-slot"
import { FormActions } from "@/components/profiles/form-kit"
import { Button } from "@/components/ui/button"
import { canBrowseFeed } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { findFeedListing } from "@/lib/feed/queries"
import { formatCount, formatRating } from "@/lib/listings/cards"

export const metadata: Metadata = { title: "Product" }

type Props = {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const rankParam = z.coerce.number().int().min(1).max(10_000).catch(0)

/**
 * A listing from the feed (CLAUDE.md §19.45): the screenshots to swipe through, the name and one
 * line, a few facts, the builder in brief, and one thing to do: send a proposal.
 */
export default async function FeedListingPage({ params, searchParams }: Props) {
  const user = await requireOnboardedUser()
  authorizePage(canBrowseFeed(user))
  const { id } = await params
  const listing = await findFeedListing(getDb(), { viewerId: user.id, productId: id })
  if (!listing) notFound()
  const rank = rankParam.parse((await searchParams).rank) || null

  const proposal = new URLSearchParams({ to: listing.builder.userId, product: listing.id })
  if (listing.matchId) proposal.set("match", listing.matchId)
  const proposeHref = `/app/proposals/new?${proposal.toString()}`
  const sourceLink = listing.sourceUrl ?? listing.demoUrl
  const facts = [listing.tag, listing.priceLabel, listing.sourceLabel].filter(
    (fact): fact is string => !!fact,
  )

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <AppBarSlot title={listing.title} back="/app/feed" />
      <RecordListingOpen productId={listing.id} rank={rank} />

      <ScreenshotCarousel listing={listing} />

      <header className="flex items-start gap-4">
        <ListingIcon listing={listing} className="size-16 ring-black/10 dark:ring-white/15" />
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-2xl leading-tight font-semibold tracking-tight text-balance">
            {listing.title}
          </h1>
          <Link
            href={`/b/${listing.builder.handle}`}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            @{listing.builder.handle}
          </Link>
        </div>
        <HeartButton
          productId={listing.id}
          title={listing.title}
          saved={listing.saved}
          rank={rank}
          variant="plain"
        />
      </header>

      {listing.hook ? <p className="text-lg leading-snug text-pretty">{listing.hook}</p> : null}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {facts.map((fact) => (
          <span key={fact} className="rounded-full bg-muted px-3 py-1 text-muted-foreground">
            {fact}
          </span>
        ))}
        {listing.rating !== null ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1">
            <Star aria-hidden="true" className="size-3.5 fill-amber-400 text-amber-400" />
            {formatRating(listing.rating)}
            {listing.ratingCount ? (
              <span className="text-muted-foreground">
                · {formatCount(listing.ratingCount)} ratings
              </span>
            ) : null}
          </span>
        ) : null}
      </div>

      <div className="hidden gap-2 sm:flex">
        <Button asChild size="lg" className="h-12 rounded-full px-6">
          <Link href={proposeHref}>
            <Send aria-hidden="true" />
            Send a proposal
          </Link>
        </Button>
        {sourceLink ? (
          <Button asChild size="lg" variant="outline" className="h-12 rounded-full px-5">
            <a href={sourceLink} target="_blank" rel="noopener noreferrer nofollow">
              <ExternalLink aria-hidden="true" />
              {listing.source === "app_store" ? "App Store" : "Visit"}
            </a>
          </Button>
        ) : null}
      </div>

      {listing.description ? (
        <section aria-labelledby="about-heading" className="space-y-2">
          <h2 id="about-heading" className="text-sm font-medium text-muted-foreground">
            About
          </h2>
          <details className="group">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <p className="line-clamp-4 text-[15px] leading-relaxed whitespace-pre-line group-open:line-clamp-none">
                {listing.description}
              </p>
              <span className="mt-1 inline-flex h-11 items-center text-sm font-medium text-primary group-open:hidden">
                More
              </span>
            </summary>
          </details>
        </section>
      ) : null}

      <section
        aria-label="The builder"
        className="flex items-center gap-4 rounded-3xl border bg-card p-4"
      >
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-base font-semibold"
        >
          {listing.builder.displayName.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate font-medium">
            {listing.builder.displayName}
            {listing.source === "app_store" ? (
              listing.unverified ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-normal text-amber-700 dark:text-amber-300">
                  <ShieldQuestion aria-hidden="true" className="size-3" />
                  Unverified
                </span>
              ) : (
                <BadgeCheck aria-label="Verified developer" className="size-4 text-sky-500" />
              )
            ) : null}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {listing.builder.bio ??
              `${listing.builder.listingCount} product${listing.builder.listingCount === 1 ? "" : "s"}`}
          </p>
        </div>
        <Button asChild variant="ghost" className="h-11 shrink-0">
          <Link href={`/b/${listing.builder.handle}`}>Profile</Link>
        </Button>
      </section>

      <FormActions className="sm:hidden">
        <Button asChild size="lg" className="h-12 w-full rounded-full">
          <Link href={proposeHref}>
            <Send aria-hidden="true" />
            Send a proposal
          </Link>
        </Button>
      </FormActions>
    </div>
  )
}
