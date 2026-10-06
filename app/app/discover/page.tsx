import type { Metadata } from "next"

import { DiscoverMatchesPage } from "@/components/discover/discover-page"
import { toShellViewer } from "@/components/layout/viewer"
import { canDiscover } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"

export const metadata: Metadata = { title: "Discover" }

/**
 * Discover → For you (§12 `/app/discover`, role-aware): the active role's top matches (§8) with a
 * score badge and a one-sentence explanation each. Creators see products and builders; builders
 * see briefs (open ideas) and creators.
 */
export default async function DiscoverPage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { activeRole } = toShellViewer(user)
  authorizePage(canDiscover(user, activeRole))
  return (
    <DiscoverMatchesPage
      db={getDb()}
      userId={user.id}
      role={activeRole}
      tab="for-you"
      title="Discover"
      description={
        activeRole === "creator"
          ? "Products and builders that fit your audience, ranked for you."
          : "Creator briefs and creators whose audience fits what you build, ranked for you."
      }
      listLabel="Your matches"
    />
  )
}
