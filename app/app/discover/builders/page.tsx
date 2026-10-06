import type { Metadata } from "next"

import { DiscoverMatchesPage } from "@/components/discover/discover-page"
import { canDiscover } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"

export const metadata: Metadata = { title: "Builders" }

/**
 * Discover → Builders (§12 `/app/discover/builders`, creators): builders matched to the creator,
 * best first. People without the creator role go back to Discover.
 */
export default async function DiscoverBuildersPage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canDiscover(user, "creator"), "/app/discover")
  return (
    <DiscoverMatchesPage
      db={getDb()}
      userId={user.id}
      role="creator"
      tab="builders"
      title="Builders"
      description="Developers whose skills and shipped work fit your audience. Send one a proposal about your idea."
      targetTypes={["builder"]}
      listLabel="Builders matched to you"
    />
  )
}
