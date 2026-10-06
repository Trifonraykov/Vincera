import { CircleCheck, FolderGit2, Send, UserPlus, Wallet, type LucideIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { CollabsHomeSection } from "@/components/collabs/home-section"
import { AudienceSnapshotSection } from "@/components/home/audience-snapshot"
import { SupplySummarySection } from "@/components/home/supply-summary"
import { TopMatchesSection } from "@/components/home/top-matches"
import { toShellViewer } from "@/components/layout/viewer"
import { ProposalsHomeSection } from "@/components/proposals/home-section"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { canEditBuilderProfile, canEditCreatorProfile, canManageOwnAccount } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { isBuiltRoute, type AppRole } from "@/lib/nav"
import type { OnboardingSnapshot } from "@/lib/onboarding/next-step"
import { loadOnboardingSnapshot } from "@/lib/onboarding/snapshot"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"

export const metadata: Metadata = { title: "Home" }

type HomeCard = {
  icon: LucideIcon
  title: string
  description: string
  action: { label: string; href: string }
}

const TITLES: Record<AppRole, { title: string; description: string }> = {
  creator: {
    title: "Creator home",
    description: "Your audience, your ideas, and the builders who can make them real.",
  },
  builder: {
    title: "Builder home",
    description: "Your products, open briefs from creators, and your next launch.",
  },
}

/**
 * Setup still to do, from the user's real state (payouts; a builder's portfolio). The rest of the
 * home page is the role's widgets (§12: `/app` is role-aware).
 */
function setupCards(role: AppRole, snapshot: OnboardingSnapshot): HomeCard[] {
  const cards: HomeCard[] = []
  if (snapshot.payouts !== "ready") {
    cards.push({
      icon: Wallet,
      title: snapshot.payouts === "pending" ? "Finish setting up payouts" : "Set up payouts",
      description: "Connect Stripe before you sign an agreement, so you get paid on every sale.",
      action: { label: "Set up payouts", href: "/app/settings/payouts" },
    })
  }
  if (
    role === "builder" &&
    snapshot.portfolioItemCount === 0 &&
    snapshot.githubConnectionCount === 0
  ) {
    cards.push({
      icon: FolderGit2,
      title: "Show your work",
      description: "Connect GitHub or add projects, so creators can see what you build.",
      action: { label: "Edit your portfolio", href: "/app/settings/profile" },
    })
  }
  return cards
}

export default async function AppHomePage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canManageOwnAccount(user))
  const { activeRole } = toShellViewer(user)
  // The home page shows the active role's own setup state (profile, connections, portfolio).
  authorizePage(
    activeRole === "creator" ? canEditCreatorProfile(user) : canEditBuilderProfile(user),
    ONBOARDING_STEP_PATHS.role,
  )
  const snapshot = await loadOnboardingSnapshot(getDb(), user.id)
  const home = TITLES[activeRole]
  const hasProfile =
    snapshot !== null &&
    (activeRole === "creator" ? snapshot.hasCreatorProfile : snapshot.hasBuilderProfile)
  const cards = snapshot ? setupCards(activeRole, snapshot) : []
  const db = getDb()

  return (
    <div className="space-y-8">
      <PageHeader
        title={home.title}
        description={home.description}
        actions={
          isBuiltRoute("/app/proposals") ? (
            <Button asChild variant="outline">
              <Link href="/app/proposals">
                <Send aria-hidden="true" />
                Proposals
              </Link>
            </Button>
          ) : null
        }
      />

      {!hasProfile ? (
        // A role added after onboarding and left midway (CLAUDE.md §19.11).
        <Alert>
          <UserPlus aria-hidden="true" />
          <AlertTitle>Set up your {activeRole} profile</AlertTitle>
          <AlertDescription>
            <p>
              {activeRole === "creator"
                ? "Builders can't find you as a creator until you have a profile."
                : "Creators can't find you as a builder until you have a profile."}
            </p>
            <Button asChild size="sm" className="mt-2">
              <Link
                href={
                  ONBOARDING_STEP_PATHS[
                    activeRole === "creator" ? "creator.profile" : "builder.profile"
                  ]
                }
              >
                Set up your profile
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {snapshot?.payouts === "ready" ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheck className="size-4 text-primary" aria-hidden="true" />
          Payouts are set up.
        </p>
      ) : null}

      {cards.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => (
            <EmptyState
              key={card.title}
              icon={card.icon}
              title={card.title}
              description={card.description}
              action={
                isBuiltRoute(card.action.href.split(/[?#]/, 1)[0] ?? "") ? (
                  <Button asChild size="sm">
                    <Link href={card.action.href}>{card.action.label}</Link>
                  </Button>
                ) : (
                  <Badge variant="secondary">Coming soon</Badge>
                )
              }
            />
          ))}
        </div>
      ) : null}

      {/* Phase 3 sections (CLAUDE.md §19.24): each renders nothing when it has nothing to show. */}
      <ProposalsHomeSection userId={user.id} role={activeRole} />
      <CollabsHomeSection userId={user.id} role={activeRole} />

      {hasProfile && activeRole === "creator" ? (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <AudienceSnapshotSection db={db} userId={user.id} />
          <SupplySummarySection db={db} userId={user.id} kind="idea" />
        </div>
      ) : null}
      {hasProfile && activeRole === "builder" ? (
        <SupplySummarySection db={db} userId={user.id} kind="product" />
      ) : null}

      {hasProfile ? <TopMatchesSection db={db} userId={user.id} role={activeRole} /> : null}
    </div>
  )
}
