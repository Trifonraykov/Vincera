import { Lightbulb, Plus } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { AppBarSlot } from "@/components/layout/app-bar-slot"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { formatPrice } from "@/components/supply/format"
import { SupplyStatusFilter } from "@/components/supply/status-filter"
import { SupplyCard, SupplyCardItem, SupplyCardList } from "@/components/supply/supply-card"
import { Button } from "@/components/ui/button"
import { canCreateIdea } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { countOwnIdeas, findCreatorContext, listOwnIdeas } from "@/lib/ideas/queries"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"
import { PRODUCT_FORMAT_LABELS } from "@/lib/profiles/fields"
import { filterCounts, filterLabel, parseSupplyFilter } from "@/lib/supply/lifecycle"

export const metadata: Metadata = { title: "Ideas" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

function NewIdeaButton({ className }: { className?: string }) {
  return (
    <Button asChild className={className}>
      <Link href="/app/ideas/new">
        <Plus aria-hidden="true" />
        New idea
      </Link>
    </Button>
  )
}

/**
 * Creator → Ideas (§12 `/app/ideas`): the creator's ideas with a status filter (`?status=`), each
 * opening `/app/ideas/[id]`. On phones "New idea" is the app bar's action; on desktop it sits in
 * the header.
 */
export default async function IdeasPage({ searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()

  if (!canCreateIdea(user)) {
    return (
      <div className="space-y-8">
        <PageHeader title="Ideas" />
        <EmptyState
          icon={Lightbulb}
          title="Ideas are for creators"
          description="Add the creator role to post what your audience wants and find builders to make it."
          action={
            <Button asChild size="sm">
              <Link href={ONBOARDING_STEP_PATHS.role}>Become a creator</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const db = getDb()
  const profile = await findCreatorContext(db, user.id)
  if (!profile) {
    return (
      <div className="space-y-8">
        <PageHeader title="Ideas" />
        <EmptyState
          icon={Lightbulb}
          title="Create your creator profile first"
          description="Ideas belong to your creator profile. It takes a minute."
          action={
            <Button asChild size="sm">
              <Link href={ONBOARDING_STEP_PATHS["creator.profile"]}>Create creator profile</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const filter = parseSupplyFilter((await searchParams).status)
  const [ideas, byStatus] = await Promise.all([
    listOwnIdeas(db, user.id, filter),
    countOwnIdeas(db, user.id),
  ])
  const counts = filterCounts("idea", byStatus)
  const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0)

  return (
    <div className="space-y-6">
      <AppBarSlot
        action={
          <Button asChild size="icon" className="size-11">
            <Link href="/app/ideas/new" aria-label="New idea">
              <Plus aria-hidden="true" />
            </Link>
          </Button>
        }
      />
      <PageHeader
        title="Ideas"
        description="What your audience wants built. Publish an idea and builders can send you proposals."
        actions={<NewIdeaButton className="hidden md:inline-flex" />}
      />

      {total === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="Post your first idea"
          description="Paste a few comments where your audience asks for something, and we'll help you turn them into an idea builders can pick up."
          action={<NewIdeaButton />}
        />
      ) : (
        <>
          <SupplyStatusFilter kind="idea" basePath="/app/ideas" current={filter} counts={counts} />
          {ideas.length === 0 ? (
            <EmptyState
              title={`No ideas in “${filterLabel("idea", filter)}”`}
              description="Pick another filter to see the rest."
              action={
                <Button asChild variant="outline" size="sm">
                  <Link href="/app/ideas">Show all ideas</Link>
                </Button>
              }
            />
          ) : (
            <SupplyCardList label="Your ideas">
              {ideas.map((idea) => (
                <SupplyCardItem key={idea.id}>
                  <SupplyCard
                    kind="idea"
                    href={`/app/ideas/${idea.id}`}
                    title={idea.title}
                    status={idea.status}
                    facts={[
                      PRODUCT_FORMAT_LABELS[idea.format],
                      formatPrice(idea.targetPriceCents, idea.currency),
                    ]}
                    topics={idea.topics}
                    updatedAt={idea.updatedAt}
                  />
                </SupplyCardItem>
              ))}
            </SupplyCardList>
          )}
        </>
      )}
    </div>
  )
}
