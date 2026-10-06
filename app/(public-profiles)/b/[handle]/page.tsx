import { FolderOpen } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound, permanentRedirect } from "next/navigation"
import { cache } from "react"

import { formatDate } from "@/components/audience/format"
import { ListingGrid } from "@/components/public-profile/listing-grid"
import { GitHubStatsSection } from "@/components/public-profile/github-stats"
import { PortfolioList } from "@/components/public-profile/portfolio-list"
import { ProfileHero } from "@/components/public-profile/profile-hero"
import { TagList } from "@/components/public-profile/tag-list"
import { EmptyState } from "@/components/shared/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { DealPreference } from "@/lib/db/schema"
import { getDb } from "@/lib/db/client"
import { env } from "@/lib/env"
import { AVAILABILITY_LABELS } from "@/lib/profiles/fields"
import { isValidHandle, loadPublicBuilderProfile } from "@/lib/public-profiles/load"
import { NOT_FOUND_METADATA, profileMetadata } from "@/lib/public-profiles/metadata"

/**
 * Public builder profile `/b/[handle]` (§12, §6: public fields only): skills, stack,
 * availability, deal preference, portfolio and GitHub stats. Server-rendered and cached for 5
 * minutes (ISR; GitHub syncs revalidate it sooner). Unknown handles and suspended accounts 404.
 */

export const revalidate = 300

/** Rendered on first visit, then cached (no profiles are prerendered at build time). */
export async function generateStaticParams(): Promise<{ handle: string }[]> {
  return []
}

type Props = { params: Promise<{ handle: string }> }

const DEAL_LABELS: Record<DealPreference, string> = {
  split: "Prefers revenue split",
  fixed: "Prefers a fixed fee",
  either: "Revenue split or fixed fee",
}

const loadProfile = cache((handle: string) => loadPublicBuilderProfile(getDb(), handle))

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params
  const profile = await loadProfile(handle.toLowerCase())
  if (!profile) return NOT_FOUND_METADATA
  const skills = [...profile.skills, ...profile.stack].slice(0, 6).join(", ")
  return profileMetadata({
    path: `/b/${profile.handle}`,
    title: `${profile.displayName} (@${profile.handle}) · Builder`,
    description:
      profile.bio ??
      (skills
        ? `${profile.displayName} builds with ${skills}.`
        : `${profile.displayName} is a builder on ${env.APP_NAME}.`),
    handle: profile.handle,
    appName: env.APP_NAME,
  })
}

export default async function BuilderProfilePage({ params }: Props) {
  const { handle } = await params
  const normalized = handle.toLowerCase()
  if (normalized !== handle && isValidHandle(normalized)) permanentRedirect(`/b/${normalized}`)
  const profile = await loadProfile(handle)
  if (!profile) notFound()

  return (
    <article className="space-y-10">
      <ProfileHero
        displayName={profile.displayName}
        handle={profile.handle}
        roleLabel="Builder"
        verified={profile.verified}
        bio={profile.bio}
        meta={[`Member since ${formatDate(profile.memberSince)}`]}
        badges={
          <>
            <Badge variant={profile.availability === "closed" ? "outline" : "secondary"}>
              {AVAILABILITY_LABELS[profile.availability].title}
            </Badge>
            <Badge variant="outline">{DEAL_LABELS[profile.dealPreference]}</Badge>
          </>
        }
      />

      {profile.skills.length > 0 || profile.stack.length > 0 ? (
        <section aria-labelledby="skills-heading" className="space-y-4">
          <h2 id="skills-heading" className="text-lg font-semibold">
            Skills and stack
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <TagList label="Skills" tags={profile.skills} />
            <TagList label="Stack" tags={profile.stack} />
          </div>
        </section>
      ) : null}

      {profile.listings.length > 0 ? (
        <section aria-labelledby="listings-heading" className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="listings-heading" className="text-lg font-semibold">
              Products
            </h2>
            {profile.appStore ? (
              <p className="text-sm text-muted-foreground">
                {profile.appStore.developerName ?? "App Store developer"} on the App Store
                {profile.appStore.verified ? " · verified" : " · unverified"}
              </p>
            ) : null}
          </div>
          <ListingGrid listings={profile.listings} />
        </section>
      ) : null}

      {profile.portfolio.length > 0 || profile.listings.length === 0 ? (
        <section aria-labelledby="portfolio-heading" className="space-y-4">
          <h2 id="portfolio-heading" className="text-lg font-semibold">
            Portfolio
          </h2>
          {profile.portfolio.length > 0 ? (
            <PortfolioList items={profile.portfolio} />
          ) : (
            <EmptyState
              icon={FolderOpen}
              title="No portfolio items yet"
              description={`${profile.displayName} hasn't added projects yet.`}
            />
          )}
        </section>
      ) : null}

      {profile.github ? <GitHubStatsSection github={profile.github} /> : null}

      <aside className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm">
          Have an audience that needs a tool? Team up with {profile.displayName} and split the
          revenue.
        </p>
        <Button asChild size="sm">
          <Link href="/sign-up">Join as a creator</Link>
        </Button>
      </aside>
    </article>
  )
}
