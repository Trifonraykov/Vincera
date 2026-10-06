import Link from "next/link"

import { PROPOSAL_TAB_LABELS, PROPOSAL_TABS, type ProposalTab } from "@/lib/proposals/display"
import type { ProposalTabCounts } from "@/lib/proposals/queries"
import { cn } from "@/lib/utils"

/**
 * Received / Sent / Closed on `/app/proposals` (§12), as links (`?tab=`), so each tab has its own
 * URL and works without JavaScript. Same look as the settings tabs.
 */
export function ProposalTabs({
  current,
  counts,
}: {
  current: ProposalTab
  counts: ProposalTabCounts
}) {
  return (
    <nav aria-label="Proposals" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b">
        {PROPOSAL_TABS.map((tab) => {
          const active = tab === current
          return (
            <li key={tab}>
              <Link
                href={tab === "received" ? "/app/proposals" : `/app/proposals?tab=${tab}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {PROPOSAL_TAB_LABELS[tab]}
                <span
                  className="rounded-full bg-muted px-1.5 text-xs tabular-nums"
                  aria-label={`${counts[tab]} ${counts[tab] === 1 ? "proposal" : "proposals"}`}
                >
                  {counts[tab]}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
