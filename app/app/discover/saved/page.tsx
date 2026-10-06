import { Bookmark } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { DiscoverTabs } from "@/components/discover/discover-tabs"
import { MatchList } from "@/components/discover/match-card"
import { NoProfileState } from "@/components/discover/discover-page"
import { toShellViewer } from "@/components/layout/viewer"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { canDiscover } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { findProfileId } from "@/lib/embeddings/entities"
import { listSavedMatches } from "@/lib/matching/queries"

export const metadata: Metadata = { title: "Saved" }

/**
 * Discover → Saved (§12 `/app/discover/saved`, a v1 route built in Phase 2): what the person saved
 * for the active role, newest first. Saved targets that closed since stay listed and say so.
 */
export default async function DiscoverSavedPage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { activeRole } = toShellViewer(user)
  authorizePage(canDiscover(user, activeRole))
  const db = getDb()
  const hasProfile = (await findProfileId(db, user.id, activeRole)) !== null
  const saved = hasProfile ? await listSavedMatches(db, user.id, activeRole) : []

  return (
    <div className="space-y-6">
      <PageHeader title="Saved" description="Matches you saved to come back to." />
      <DiscoverTabs role={activeRole} current="saved" />
      {!hasProfile ? (
        <NoProfileState role={activeRole} />
      ) : saved.length === 0 ? (
        <EmptyState
          icon={Bookmark}
          title="Nothing saved yet"
          description="Tap Save on a match to keep it here."
          action={
            <Button asChild size="sm" className="h-11 sm:h-8">
              <Link href="/app/discover">See your matches</Link>
            </Button>
          }
        />
      ) : (
        <MatchList matches={saved} label="Saved matches" />
      )}
    </div>
  )
}
