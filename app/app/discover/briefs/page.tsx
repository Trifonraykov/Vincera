import { Lightbulb } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { BriefCard } from "@/components/discover/brief-card"
import { DiscoverMatchesPage } from "@/components/discover/discover-page"
import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { canDiscover } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { findProfileId } from "@/lib/embeddings/entities"
import { listCurrentMatches, listOtherOpenBriefs } from "@/lib/matching/queries"

export const metadata: Metadata = { title: "Briefs" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const PAGE_SIZE = 20

function pageParam(value: string | string[] | undefined): number {
  const parsed = Number.parseInt(Array.isArray(value) ? (value[0] ?? "") : (value ?? ""), 10)
  return Number.isFinite(parsed) && parsed > 1 && parsed < 1000 ? parsed : 1
}

/**
 * Discover → Briefs (§12 `/app/discover/briefs`, builders): open ideas posted by creators. First
 * the ones matched to the builder (ranked, with explanations), then every other open brief, newest
 * first, 20 per page (`?page=`), so nothing open is out of reach.
 */
export default async function DiscoverBriefsPage({ searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canDiscover(user, "builder"), "/app/discover")
  const db = getDb()
  const page = pageParam((await searchParams).page)
  const hasProfile = (await findProfileId(db, user.id, "builder")) !== null
  const matched = hasProfile
    ? await listCurrentMatches(db, user.id, "builder", { targetTypes: ["idea"] })
    : []
  const others = hasProfile
    ? await listOtherOpenBriefs(db, user.id, {
        excludeIds: matched.map((match) => match.target.id),
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      })
    : { items: [], hasMore: false }

  return (
    <DiscoverMatchesPage
      db={db}
      userId={user.id}
      role="builder"
      tab="briefs"
      title="Briefs"
      description="Product ideas creators posted for their audiences. The best fits for you come first."
      targetTypes={["idea"]}
      listLabel="Briefs matched to you"
    >
      {hasProfile ? (
        <section aria-labelledby="more-briefs" className="space-y-4 pt-2">
          <h2 id="more-briefs" className="font-semibold">
            More open briefs
          </h2>
          {others.items.length === 0 ? (
            <EmptyState
              icon={Lightbulb}
              title={page > 1 ? "No more briefs" : "No other open briefs right now"}
              description="Creators post new ideas every day."
              action={
                page > 1 ? (
                  <Button asChild size="sm" variant="outline" className="h-11 sm:h-8">
                    <Link href="/app/discover/briefs">Back to the newest</Link>
                  </Button>
                ) : null
              }
            />
          ) : (
            <ul aria-label="More open briefs" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {others.items.map((idea) => (
                <BriefCard key={idea.id} idea={idea} />
              ))}
            </ul>
          )}
          {others.hasMore || page > 1 ? (
            <nav aria-label="More briefs" className="flex justify-center gap-2">
              {page > 1 ? (
                <Button asChild variant="outline" className="h-11 sm:h-9">
                  <Link
                    href={
                      page === 2 ? "/app/discover/briefs" : `/app/discover/briefs?page=${page - 1}`
                    }
                  >
                    Newer
                  </Link>
                </Button>
              ) : null}
              {others.hasMore ? (
                <Button asChild variant="outline" className="h-11 sm:h-9">
                  <Link href={`/app/discover/briefs?page=${page + 1}`}>Older briefs</Link>
                </Button>
              ) : null}
            </nav>
          ) : null}
        </section>
      ) : null}
    </DiscoverMatchesPage>
  )
}
