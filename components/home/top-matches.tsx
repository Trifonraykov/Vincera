import { Compass } from "lucide-react"

import { MatchList } from "@/components/discover/match-card"
import { RefreshMatchesButton } from "@/components/discover/refresh-matches-button"
import { EmptyState } from "@/components/shared/empty-state"
import type { DbOrTx } from "@/lib/db/client"
import { listCurrentMatches } from "@/lib/matching/queries"
import type { AppRole } from "@/lib/nav"

import { HomeSection } from "./section"

/**
 * "Top matches" on `/app` (§12 role-aware home): the active role's three best matches with their
 * explanations, compact; "See all" opens Discover. Records `match.shown` like Discover does.
 */
export async function TopMatchesSection({
  db,
  userId,
  role,
}: {
  db: DbOrTx
  userId: string
  role: AppRole
}) {
  const matches = await listCurrentMatches(db, userId, role, { limit: 3 })
  return (
    <HomeSection
      id="home-matches"
      icon={Compass}
      title="Top matches"
      link={matches.length > 0 ? { href: "/app/discover", label: "See all" } : null}
    >
      {matches.length === 0 ? (
        <EmptyState
          icon={Compass}
          title="No matches yet"
          description={
            role === "creator"
              ? "Builders and products that fit your audience appear here once we've matched you."
              : "Briefs and creators that fit what you build appear here once we've matched you."
          }
          action={<RefreshMatchesButton role={role} variant="default" />}
        />
      ) : (
        <MatchList matches={matches} label="Your top matches" compact />
      )}
    </HomeSection>
  )
}
