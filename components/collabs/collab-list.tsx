import { ChevronRight, Lightbulb, Package } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { COLLAB_ROLE_LABELS, collabNextStep } from "@/lib/collabs/display"
import type { CollabListItem } from "@/lib/collabs/queries"
import { formatRelative } from "@/lib/proposals/display"
import { cn } from "@/lib/utils"

import { CollabStageBadge } from "./stage-badge"

/**
 * Collabs as tappable rows (one link per row, at least 44 px tall): what it is about, with whom,
 * the viewer's split, the stage, and the next step ("Your turn" when it is the viewer's).
 */
export function CollabList({
  items,
  now,
  className,
}: {
  items: readonly CollabListItem[]
  now: Date
  className?: string
}) {
  return (
    <ul className={cn("divide-y overflow-hidden rounded-xl border bg-card shadow-xs", className)}>
      {items.map((item) => {
        const Icon = item.targetKind === "idea" ? Lightbulb : Package
        const next = collabNextStep(item)
        return (
          <li key={item.id}>
            <Link
              href={
                next.needsViewer ? `/app/collabs/${item.id}/agreement` : `/app/collabs/${item.id}`
              }
              className="flex min-h-11 items-start gap-3 p-4 transition-colors outline-none hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{item.title}</span>
                  {next.needsViewer ? <Badge>Your turn</Badge> : null}
                </span>
                <span className="block text-sm text-muted-foreground">
                  With {item.partners.map((partner) => partner.name).join(", ") || "—"} · You:{" "}
                  {COLLAB_ROLE_LABELS[item.role].toLowerCase()}, {item.splitPct}%
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <CollabStageBadge stage={item.stage} />
                  <span>{next.text}</span>
                  <span aria-hidden="true">·</span>
                  <span>Last activity {formatRelative(item.lastActivityAt, now)}</span>
                </span>
              </span>
              <ChevronRight
                className="mt-2 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
