import { Handshake } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { CollabList } from "@/components/collabs/collab-list"
import { CollabStageFilter } from "@/components/collabs/stage-filter"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { now } from "@/lib/clock"
import {
  COLLAB_FILTERS,
  collabFilterLabel,
  matchesCollabFilter,
  parseCollabFilter,
  type CollabFilter,
} from "@/lib/collabs/display"
import { listCollabsForUser } from "@/lib/collabs/queries"
import { getDb } from "@/lib/db/client"

export const metadata: Metadata = { title: "Collabs" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/**
 * Collabs (§12 `/app/collabs`): the collabs the user is a member of (§6: only their own), by stage
 * (`?stage=`, "Active" by default), each with the partner, the user's split and the next step;
 * a collab waiting for the user's signature opens on its agreement. The same page for both roles.
 */
export default async function CollabsPage({ searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canManageOwnAccount(user))

  const filter = parseCollabFilter((await searchParams).stage)
  const all = await listCollabsForUser(getDb(), user.id)
  const counts = Object.fromEntries(
    COLLAB_FILTERS.map((option) => [
      option,
      all.filter((item) => matchesCollabFilter(item.stage, option)).length,
    ]),
  ) as Record<CollabFilter, number>
  const items = all.filter((item) => matchesCollabFilter(item.stage, filter))
  const at = now()

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Collabs"
        description="Everything you're building with someone: sign the agreement, plan the work, talk it through."
      />
      {all.length === 0 ? (
        <EmptyState
          icon={Handshake}
          title="No collabs yet"
          description="A collab starts when a proposal is accepted. Send one, or answer the ones you've received."
          action={
            <Button asChild size="sm" className="h-11 sm:h-8">
              <Link href="/app/proposals">See your proposals</Link>
            </Button>
          }
        />
      ) : (
        <>
          <CollabStageFilter current={filter} counts={counts} />
          {items.length === 0 ? (
            <EmptyState
              title={`No collabs in “${collabFilterLabel(filter)}”`}
              description="Pick another filter to see the rest."
              action={
                <Button asChild variant="outline" size="sm" className="h-11 sm:h-8">
                  <Link href="/app/collabs?stage=all">Show all collabs</Link>
                </Button>
              }
            />
          ) : (
            <CollabList items={items} now={at} />
          )}
        </>
      )}
    </div>
  )
}
