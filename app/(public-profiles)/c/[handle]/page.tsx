import { Users } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound, permanentRedirect } from "next/navigation"
import { cache } from "react"

import { countryLabel, formatCompact, formatDate } from "@/components/audience/format"
import { SizeTierBadge } from "@/components/audience/size-tier-badge"
import { PlatformList } from "@/components/public-profile/platform-list"
import { ProfileHero } from "@/components/public-profile/profile-hero"
import { TagList } from "@/components/public-profile/tag-list"
import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { getDb } from "@/lib/db/client"
import { languageName } from "@/lib/profiles/locale"
import { env } from "@/lib/env"
import { isValidHandle, loadPublicCreatorProfile } from "@/lib/public-profiles/load"
import { NOT_FOUND_METADATA, profileMetadata } from "@/lib/public-profiles/metadata"

/**
 * Public creator profile `/c/[handle]` (§12, §6: public fields only). Server-rendered and cached
 * for 5 minutes (ISR; social syncs and summary edits revalidate it sooner). Unknown handles and
 * suspended accounts are 404s.
 */

export const revalidate = 300

/** Rendered on first visit, then cached (no profiles are prerendered at build time). */
export async function generateStaticParams(): Promise<{ handle: string }[]> {
  return []
}

type Props = { params: Promise<{ handle: string }> }

const loadProfile = cache((handle: string) => loadPublicCreatorProfile(getDb(), handle))

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params
  const profile = await loadProfile(handle.toLowerCase())
  if (!profile) return NOT_FOUND_METADATA
  return profileMetadata({
    path: `/c/${profile.handle}`,
    title: `${profile.displayName} (@${profile.handle}) · Creator`,
    description:
      profile.bio ??
      profile.audienceSummary ??
      `${profile.displayName} is a creator on ${env.APP_NAME}.`,
    handle: profile.handle,
    appName: env.APP_NAME,
  })
}

export default async function CreatorProfilePage({ params }: Props) {
  const { handle } = await params
  const normalized = handle.toLowerCase()
  if (normalized !== handle && isValidHandle(normalized)) permanentRedirect(`/c/${normalized}`)
  const profile = await loadProfile(handle)
  if (!profile) notFound()

  const meta = [
    profile.niche,
    profile.country ? countryLabel(profile.country) : null,
    profile.languages.length > 0 ? profile.languages.map(languageName).join(", ") : null,
    `Member since ${formatDate(profile.memberSince)}`,
  ].filter((item): item is string => item !== null)

  return (
    <article className="space-y-10">
      <ProfileHero
        displayName={profile.displayName}
        handle={profile.handle}
        roleLabel="Creator"
        verified={profile.verified}
        bio={profile.bio}
        meta={meta}
        badges={
          profile.sizeTier ? (
            <SizeTierBadge tier={profile.sizeTier} verified={profile.sizeTierVerified} showRange />
          ) : null
        }
      />

      <section aria-labelledby="audience-heading" className="space-y-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="audience-heading" className="text-lg font-semibold">
            Audience
          </h2>
          {profile.verifiedReach !== null ? (
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">
                {formatCompact(profile.verifiedReach)}
              </span>{" "}
              verified followers across platforms
            </p>
          ) : null}
        </div>

        {profile.audienceSummary ? (
          <p className="max-w-prose leading-relaxed text-pretty">{profile.audienceSummary}</p>
        ) : null}
        <TagList label="Topics" tags={profile.topics} />

        {profile.platforms.length > 0 ? (
          <PlatformList platforms={profile.platforms} />
        ) : (
          <EmptyState
            icon={Users}
            title="No platforms connected yet"
            description={`${profile.displayName} hasn't shared audience numbers yet.`}
          />
        )}
        <p className="text-xs text-muted-foreground">
          Verified numbers come straight from the platform. Unverified numbers were entered by the
          creator and haven&apos;t been checked yet.
        </p>
      </section>

      <aside className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm">
          Build something for {profile.displayName}&apos;s audience and split the revenue.
        </p>
        <Button asChild size="sm">
          <Link href="/sign-up">Join as a builder</Link>
        </Button>
      </aside>
    </article>
  )
}
