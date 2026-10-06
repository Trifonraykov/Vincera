import { Compass, Inbox, Send } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { z } from "zod"

import { ProposalList } from "@/components/proposals/proposal-list"
import { ProposalTabs } from "@/components/proposals/proposal-tabs"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import { isBuiltRoute } from "@/lib/nav"
import { parseProposalTab, type ProposalTab } from "@/lib/proposals/display"
import {
  countProposalTabs,
  listProposals,
  proposalCursorAfter,
  type ProposalCursor,
} from "@/lib/proposals/queries"

export const metadata: Metadata = { title: "Proposals" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/** `?before=<iso>_<id>`: the page after the given proposal on the tab (keyset paging). */
const cursorSchema = z
  .string()
  .regex(/^[^_]+_[0-9a-f-]{36}$/)
  .transform((value): ProposalCursor => {
    const [time = "", id = ""] = value.split("_")
    return { at: new Date(time), id }
  })
  .refine((cursor) => !Number.isNaN(cursor.at.getTime()))

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

const EMPTY: Record<ProposalTab, { title: string; description: string }> = {
  received: {
    title: "No proposals waiting",
    description:
      "When a creator or builder sends you a proposal, it shows up here. You'll get an email too.",
  },
  sent: {
    title: "No open proposals from you",
    description:
      "Find someone in Discover and send a proposal: a split, a scope and a timeline. It's open for 14 days.",
  },
  closed: {
    title: "Nothing closed yet",
    description: "Accepted, declined, withdrawn and expired proposals end up here.",
  },
}

/**
 * Proposals (§12 `/app/proposals`): received / sent / closed. Proposals go both ways (§1), so both
 * roles see the same page; each row says whose turn it is. Only the user's own proposals are
 * listed (the queries are scoped to them).
 */
export default async function ProposalsPage({ searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canManageOwnAccount(user))
  const params = await searchParams
  const tab = parseProposalTab(params.tab)
  const before = cursorSchema.safeParse(first(params.before))
  const db = getDb()
  const [{ items, hasMore }, counts] = await Promise.all([
    listProposals(db, user.id, tab, { before: before.success ? before.data : undefined }),
    countProposalTabs(db, user.id),
  ])
  const last = items.at(-1)
  const olderHref = last
    ? `/app/proposals?${new URLSearchParams({
        tab,
        before: (({ at, id }) => `${at.toISOString()}_${id}`)(proposalCursorAfter(last, tab)),
      }).toString()}`
    : null
  const discover = isBuiltRoute("/app/discover") ? "/app/discover" : null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Proposals"
        description={
          counts.yourTurn > 0
            ? `${counts.yourTurn} ${counts.yourTurn === 1 ? "proposal is" : "proposals are"} waiting for your answer.`
            : "Offers to work together: who gets what, what you'll build and by when."
        }
        actions={
          discover ? (
            <Button asChild variant="outline" className="hidden md:inline-flex">
              <Link href={discover}>
                <Compass aria-hidden="true" />
                Find people
              </Link>
            </Button>
          ) : null
        }
      />
      <ProposalTabs current={tab} counts={counts} />
      {items.length === 0 ? (
        <EmptyState
          icon={tab === "sent" ? Send : Inbox}
          title={before.success ? "No older proposals" : EMPTY[tab].title}
          description={EMPTY[tab].description}
          action={
            discover && tab !== "closed" ? (
              <Button asChild size="sm" className="h-11 sm:h-8">
                <Link href={discover}>Find people to work with</Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          <ProposalList items={items} now={now()} />
          <div className="flex flex-wrap justify-center gap-2">
            {before.success ? (
              <Button asChild variant="ghost" className="h-11 sm:h-9">
                <Link href={`/app/proposals?tab=${tab}`}>Back to the newest</Link>
              </Button>
            ) : null}
            {hasMore && olderHref ? (
              <Button asChild variant="outline" className="h-11 sm:h-9">
                <Link href={olderHref}>Older proposals</Link>
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}
