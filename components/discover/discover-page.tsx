import { Compass, UserPlus } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import type { DbOrTx } from "@/lib/db/client"
import type { TargetType } from "@/lib/db/schema"
import { findProfileId } from "@/lib/embeddings/entities"
import { hasAnyMatches, listCurrentMatches } from "@/lib/matching/queries"
import { isBuiltRoute, type AppRole } from "@/lib/nav"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"

import { DiscoverTabs, type DiscoverTab } from "./discover-tabs"
import { MatchList } from "./match-card"
import { RefreshMatchesButton } from "./refresh-matches-button"

/** What makes matches better, per role (the empty states point there). */
const IMPROVE: Record<AppRole, { text: string; href: string; label: string }> = {
  creator: {
    text: "Post an idea and connect your audience: both sharpen who we suggest.",
    href: "/app/ideas/new",
    label: "Post an idea",
  },
  builder: {
    text: "List a product and add shipped work to your portfolio: both sharpen who we suggest.",
    href: "/app/products/new",
    label: "List a product",
  },
}

/** "Set up your <role> profile" for a role whose profile does not exist (CLAUDE.md §19.11). */
export function NoProfileState({ role }: { role: AppRole }) {
  return (
    <EmptyState
      icon={UserPlus}
      title={`Set up your ${role} profile first`}
      description={
        role === "creator"
          ? "Builders are matched to your profile and audience."
          : "Creators and briefs are matched to your skills and work."
      }
      action={
        <Button asChild size="sm" className="h-11 sm:h-8">
          <Link
            href={ONBOARDING_STEP_PATHS[role === "creator" ? "creator.profile" : "builder.profile"]}
          >
            Set up your profile
          </Link>
        </Button>
      }
    />
  )
}

/**
 * The body every ranked Discover page shares (For you, Builders, Creators): header, tabs, the
 * ranked list with explanations, and real empty states (no profile; not computed yet; nothing
 * left after dismissals). Pages authorize first and pass the role whose list they show.
 */
export async function DiscoverMatchesPage({
  db,
  userId,
  role,
  tab,
  title,
  description,
  targetTypes,
  listLabel,
  children,
}: {
  db: DbOrTx
  userId: string
  role: AppRole
  tab: DiscoverTab
  title: string
  description: string
  targetTypes?: readonly TargetType[]
  listLabel: string
  children?: ReactNode
}) {
  const header = (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={<RefreshMatchesButton role={role} />}
      />
      <DiscoverTabs role={role} current={tab} />
    </>
  )

  if (!(await findProfileId(db, userId, role))) {
    return (
      <div className="space-y-6">
        {header}
        <NoProfileState role={role} />
      </div>
    )
  }

  const matches = await listCurrentMatches(db, userId, role, { targetTypes })
  const improve = IMPROVE[role]
  const improveLink = isBuiltRoute(improve.href.replace(/\/new$/, "")) ? improve : null

  return (
    <div className="space-y-6">
      {header}
      {matches.length === 0 ? (
        (await hasAnyMatches(db, userId)) ? (
          <EmptyState
            icon={Compass}
            title="No matches here right now"
            description={`New people and listings arrive every day. ${improve.text}`}
            action={
              improveLink ? (
                <Button asChild size="sm" className="h-11 sm:h-8">
                  <Link href={improveLink.href}>{improveLink.label}</Link>
                </Button>
              ) : null
            }
          />
        ) : (
          <EmptyState
            icon={Compass}
            title="We're finding your matches"
            description={`Matches appear here shortly after your profile is set up, and update every night. ${improve.text}`}
            action={<RefreshMatchesButton role={role} variant="default" />}
          />
        )
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {matches.length === 1 ? "1 match" : `${matches.length} matches`}, best first. Save the
            ones you like; dismiss the rest and we won&apos;t suggest them again.
          </p>
          <MatchList matches={matches} label={listLabel} />
        </>
      )}
      {children}
    </div>
  )
}
