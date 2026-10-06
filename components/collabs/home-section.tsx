import { Handshake } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { now } from "@/lib/clock"
import { collabNextStep } from "@/lib/collabs/display"
import { listCollabsForUser } from "@/lib/collabs/queries"
import { getDb } from "@/lib/db/client"
import type { AppRole } from "@/lib/nav"

import { CollabList } from "./collab-list"

export type CollabsHomeSectionProps = { userId: string; role: AppRole }

/**
 * The collabs part of `/app` (CLAUDE.md §19.24 "Home page"): the user's active collabs with their
 * stage, those waiting for their signature first, at most three; nothing when there are none. An
 * async server component; `app/app/page.tsx` (owned by "matching") renders it for both roles and
 * has already checked the user.
 */
export async function CollabsHomeSection({ userId }: CollabsHomeSectionProps) {
  const active = await listCollabsForUser(getDb(), userId, { activeOnly: true })
  if (active.length === 0) return null
  const items = [...active]
    .sort(
      (a, b) =>
        Number(collabNextStep(b).needsViewer) - Number(collabNextStep(a).needsViewer) ||
        b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
    )
    .slice(0, 3)
  return (
    <section aria-labelledby="home-collabs" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="home-collabs" className="flex items-center gap-2 font-semibold">
          <Handshake className="size-4 text-muted-foreground" aria-hidden="true" />
          Your collabs
        </h2>
        <Button asChild variant="ghost" size="sm" className="h-11 sm:h-8">
          <Link href="/app/collabs">All collabs</Link>
        </Button>
      </div>
      <CollabList items={items} now={now()} />
    </section>
  )
}
