import Link from "next/link"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * Small presentational pieces shared by the admin pages (Phase 6; CLAUDE.md §19.39), mobile
 * first: chips that scroll sideways inside their own row with 44 px targets on phones, sections
 * with a heading, definition grids that stack on phones, and tables that scroll inside their own
 * box.
 */

export type Chip = { href: string; label: string; active: boolean; count?: number }

export function FilterChips({ label, chips }: { label: string; chips: Chip[] }) {
  return (
    <nav aria-label={label} className="-mx-4 sm:mx-0">
      <ul className="flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 py-1 sm:px-0">
        {chips.map((chip) => (
          <li key={chip.href} className="shrink-0">
            <Link
              href={chip.href}
              aria-current={chip.active ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors sm:min-h-8 sm:px-3",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                chip.active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-background hover:bg-accent",
              )}
            >
              {chip.label}
              {chip.count !== undefined ? (
                <span className="tabular-nums opacity-80">{chip.count}</span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function Section({
  title,
  description,
  id,
  actions,
  children,
}: {
  title: string
  description?: ReactNode
  id?: string
  actions?: ReactNode
  children: ReactNode
}) {
  const headingId = id ? `${id}-heading` : undefined
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="scroll-mt-24 space-y-3 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 id={headingId} className="text-lg font-semibold">
            {title}
          </h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="font-medium break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A table that scrolls sideways inside its own box on phones, never the page. */
export function ScrollTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0" role="region" aria-label={label} tabIndex={0}>
      <table className="w-full min-w-[36rem] text-left text-sm">{children}</table>
    </div>
  )
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn("border-b px-4 py-2 font-medium text-muted-foreground sm:px-2", className)}
    >
      {children}
    </th>
  )
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn("border-b px-4 py-2 align-top sm:px-2", className)}>{children}</td>
}

const TONES = {
  neutral: "secondary",
  good: "default",
  warn: "outline",
  bad: "destructive",
} as const

export function StatusPill({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof TONES
  children: ReactNode
}) {
  return <Badge variant={TONES[tone]}>{children}</Badge>
}

/** "Newer" / "Older" keyset links. */
export function Pager({ olderHref, newestHref }: { olderHref?: string; newestHref?: string }) {
  if (!olderHref && !newestHref) return null
  return (
    <nav aria-label="Pages" className="flex flex-wrap gap-3">
      {newestHref ? (
        <Link
          href={newestHref}
          className="inline-flex min-h-11 items-center text-sm font-medium underline-offset-4 hover:underline sm:min-h-0"
        >
          Back to the newest
        </Link>
      ) : null}
      {olderHref ? (
        <Link
          href={olderHref}
          className="inline-flex min-h-11 items-center text-sm font-medium underline-offset-4 hover:underline sm:min-h-0"
        >
          Older
        </Link>
      ) : null}
    </nav>
  )
}

/** Short date + time in UTC (admins compare times across zones). */
export function formatUtc(date: Date | null | undefined): string {
  if (!date) return "—"
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`
}

export function shortId(id: string): string {
  return id.slice(-8)
}
