import { ChevronRight } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

import type { SupplyKind, SupplyStatus } from "@/lib/supply/lifecycle"

import { formatDay } from "./format"
import { SupplyStatusBadge } from "./status-badge"

/**
 * One idea or product in a list: the whole card is the link (a large tap target on phones), with
 * the status, the title, a line of facts and when it last changed.
 */
export function SupplyCard({
  kind,
  href,
  title,
  status,
  facts,
  topics,
  updatedAt,
}: {
  kind: SupplyKind
  href: string
  title: string
  status: SupplyStatus
  facts: (string | null)[]
  topics: readonly string[]
  updatedAt: Date
}) {
  const line = facts.filter((fact): fact is string => Boolean(fact)).join(" · ")
  return (
    <Link
      href={href}
      className="group flex min-h-11 items-center gap-3 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <SupplyStatusBadge kind={kind} status={status} />
          <span className="text-xs text-muted-foreground">Updated {formatDay(updatedAt)}</span>
        </div>
        <p className="font-medium text-pretty break-words">{title}</p>
        {line ? <p className="text-sm text-muted-foreground">{line}</p> : null}
        {topics.length > 0 ? (
          <p className="truncate text-xs text-muted-foreground">{topics.join(" · ")}</p>
        ) : null}
      </div>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </Link>
  )
}

/** A list of cards. */
export function SupplyCardList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div role="list" aria-label={label} className="grid gap-3 lg:grid-cols-2">
      {children}
    </div>
  )
}

export function SupplyCardItem({ children }: { children: ReactNode }) {
  return <div role="listitem">{children}</div>
}
