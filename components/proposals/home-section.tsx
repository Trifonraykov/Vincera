import { Send } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import type { AppRole } from "@/lib/nav"
import { listProposalsAwaitingUser } from "@/lib/proposals/queries"

import { ProposalList } from "./proposal-list"

export type ProposalsHomeSectionProps = { userId: string; role: AppRole }

/**
 * The proposals part of `/app` (CLAUDE.md §19.24 "Home page"): open proposals waiting for this
 * user's answer, soonest to expire first, each linking to `/app/proposals/<id>`; nothing when
 * there are none. The same list for both roles: proposals go both ways. `app/app/page.tsx` (owned
 * by "matching") renders it; the page has already checked the user.
 */
export async function ProposalsHomeSection({ userId }: ProposalsHomeSectionProps) {
  const items = await listProposalsAwaitingUser(getDb(), userId, 3)
  if (items.length === 0) return null
  return (
    <section aria-labelledby="home-proposals" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="home-proposals" className="flex items-center gap-2 font-semibold">
          <Send className="size-4 text-muted-foreground" aria-hidden="true" />
          Waiting for your answer
        </h2>
        <Button asChild variant="ghost" size="sm" className="h-11 sm:h-8">
          <Link href="/app/proposals">All proposals</Link>
        </Button>
      </div>
      <ProposalList items={items} now={now()} />
    </section>
  )
}
