import type { Metadata } from "next"

import { DiscoverMatchesPage } from "@/components/discover/discover-page"
import { canDiscover } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"

export const metadata: Metadata = { title: "Creators" }

/**
 * Discover → Creators (§12 `/app/discover/creators`, builders): creators with a verified audience
 * matched to the builder, best first. People without the builder role go back to Discover.
 */
export default async function DiscoverCreatorsPage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canDiscover(user, "builder"), "/app/discover")
  return (
    <DiscoverMatchesPage
      db={getDb()}
      userId={user.id}
      role="builder"
      tab="creators"
      title="Creators"
      description="Creators with verified audiences that fit what you build. Offer one of your products."
      targetTypes={["creator"]}
      listLabel="Creators matched to you"
    />
  )
}
