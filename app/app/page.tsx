import { Compass, Lightbulb, Package, Send, Users, Wallet, type LucideIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { toShellViewer } from "@/components/layout/viewer"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { requireOnboardedUser } from "@/lib/auth/session"
import type { AppRole } from "@/lib/nav"

export const metadata: Metadata = { title: "Home" }

type HomeCard = {
  icon: LucideIcon
  title: string
  description: string
  action: { label: string; href: string }
}

/** Placeholder widgets per active role (§12: `/app` is role-aware); real data from Phase 1. */
const HOME: Record<AppRole, { title: string; description: string; cards: HomeCard[] }> = {
  creator: {
    title: "Creator home",
    description: "Your audience, your ideas, and the builders who can make them real.",
    cards: [
      {
        icon: Users,
        title: "Connect your audience",
        description: "Link YouTube, Instagram or TikTok so builders can see who you reach.",
        action: { label: "Connect an account", href: "/app/settings/connections" },
      },
      {
        icon: Lightbulb,
        title: "No ideas yet",
        description: "Post what your audience keeps asking for. Builders pitch on open ideas.",
        action: { label: "Post an idea", href: "/app/ideas/new" },
      },
      {
        icon: Compass,
        title: "No matches yet",
        description: "Once your profile is complete, ranked builder matches appear here.",
        action: { label: "Discover builders", href: "/app/discover/builders" },
      },
    ],
  },
  builder: {
    title: "Builder home",
    description: "Your products, open briefs from creators, and your next launch.",
    cards: [
      {
        icon: Package,
        title: "No products yet",
        description: "List something you built or want to build that needs distribution.",
        action: { label: "List a product", href: "/app/products/new" },
      },
      {
        icon: Lightbulb,
        title: "Browse creator briefs",
        description: "Ideas posted by creators, ranked by how well they fit your skills.",
        action: { label: "See briefs", href: "/app/discover/briefs" },
      },
      {
        icon: Wallet,
        title: "Set up payouts",
        description: "Connect Stripe before you sign an agreement, so you get paid on every sale.",
        action: { label: "Set up payouts", href: "/app/settings/payouts" },
      },
    ],
  },
}

export default async function AppHomePage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const { activeRole } = toShellViewer(await requireOnboardedUser())
  const home = HOME[activeRole]

  return (
    <div className="space-y-8">
      <PageHeader
        title={home.title}
        description={home.description}
        actions={
          <Button asChild variant="outline">
            <Link href="/app/proposals">
              <Send aria-hidden="true" />
              Proposals
            </Link>
          </Button>
        }
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {home.cards.map((card) => (
          <EmptyState
            key={card.title}
            icon={card.icon}
            title={card.title}
            description={card.description}
            action={
              <Button asChild size="sm">
                <Link href={card.action.href}>{card.action.label}</Link>
              </Button>
            }
          />
        ))}
      </div>
    </div>
  )
}
