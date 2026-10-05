import {
  CircleCheck,
  Compass,
  FolderGit2,
  Lightbulb,
  Package,
  Send,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { toShellViewer } from "@/components/layout/viewer"
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
 * Cards per active role (§12: `/app` is role-aware). Setup cards come from the user's real state
 * (connections, portfolio, payouts); the rest describe the next phases' pages, and say "Coming
 * soon" instead of linking until those pages are built (`isBuiltRoute`).
 */
function homeCards(role: AppRole, snapshot: OnboardingSnapshot): HomeCard[] {
  const payoutsCard: HomeCard | null =
    snapshot.payouts === "ready"
      ? null
      : {
          icon: Wallet,
          title: snapshot.payouts === "pending" ? "Finish setting up payouts" : "Set up payouts",
          description:
            "Connect Stripe before you sign an agreement, so you get paid on every sale.",
          action: { label: "Set up payouts", href: "/app/settings/payouts" },
        }

  const cards: (HomeCard | null)[] =
    role === "creator"
      ? [
          snapshot.creatorConnectionCount === 0
            ? {
                icon: Users,
                title: "Connect your audience",
                description: "Link YouTube, Instagram or TikTok so builders can see who you reach.",
                action: { label: "Connect an account", href: "/app/settings/connections" },
              }
            : {
                icon: Users,
                title: "Your audience",
                description: "Follower counts, engagement and who watches, from your accounts.",
                action: { label: "See your audience", href: "/app/audience" },
              },
          {
            icon: Lightbulb,
            title: "No ideas yet",
            description: "Post what your audience keeps asking for. Builders pitch on open ideas.",
            action: { label: "Post an idea", href: "/app/ideas/new" },
          },
          payoutsCard ?? {
            icon: Compass,
            title: "No matches yet",
            description: "Once your profile is complete, ranked builder matches appear here.",
            action: { label: "Discover builders", href: "/app/discover/builders" },
          },
        ]
      : [
          {
            icon: Package,
            title: "No products yet",
            description: "List something you built or want to build that needs distribution.",
            action: { label: "List a product", href: "/app/products/new" },
          },
          snapshot.portfolioItemCount === 0 && snapshot.githubConnectionCount === 0
            ? {
                icon: FolderGit2,
                title: "Show your work",
                description: "Connect GitHub or add projects, so creators can see what you build.",
                action: { label: "Edit your portfolio", href: "/app/settings/profile" },
              }
            : {
                icon: Lightbulb,
                title: "Browse creator briefs",
                description: "Ideas posted by creators, ranked by how well they fit your skills.",
                action: { label: "See briefs", href: "/app/discover/briefs" },
              },
          payoutsCard ?? {
            icon: Compass,
            title: "Find creators",
            description: "Creators whose audience fits what you build, ranked for you.",
            action: { label: "Discover creators", href: "/app/discover/creators" },
          },
        ]
  return cards.filter((card): card is HomeCard => card !== null)
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
  const cards = snapshot ? homeCards(activeRole, snapshot) : []

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

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
    </div>
  )
}
