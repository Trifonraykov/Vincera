import { Lightbulb, Package, Plus } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { SupplyStatusBadge } from "@/components/supply/status-badge"
import { Button } from "@/components/ui/button"
import type { DbOrTx } from "@/lib/db/client"
import { countOwnIdeas, listOwnIdeas } from "@/lib/ideas/queries"
import { countOwnProducts, listOwnProducts } from "@/lib/products/queries"
import { filterCounts, type SupplyKind } from "@/lib/supply/lifecycle"

import { HomeSection } from "./section"

const COPY: Record<
  SupplyKind,
  { title: string; empty: string; emptyText: string; newLabel: string; base: string; live: string }
> = {
  idea: {
    title: "My ideas",
    empty: "Post your first idea",
    emptyText: "Tell builders what your audience keeps asking for. Builders pitch on open ideas.",
    newLabel: "New idea",
    base: "/app/ideas",
    live: "open",
  },
  product: {
    title: "My products",
    empty: "List your first product",
    emptyText: "List something you built, or want to build, that needs a creator's audience.",
    newLabel: "New product",
    base: "/app/products",
    live: "seeking",
  },
}

/**
 * "My ideas" (creators) or "My products" (builders) on `/app`: counts by status and the three
 * most recently changed, each linking to its page; a first-item call to action when empty.
 */
export async function SupplySummarySection({
  db,
  userId,
  kind,
}: {
  db: DbOrTx
  userId: string
  kind: SupplyKind
}) {
  const copy = COPY[kind]
  const Icon = kind === "idea" ? Lightbulb : Package
  const [items, byStatus] =
    kind === "idea"
      ? await Promise.all([listOwnIdeas(db, userId, "all"), countOwnIdeas(db, userId)])
      : await Promise.all([listOwnProducts(db, userId, "all"), countOwnProducts(db, userId)])
  const counts = filterCounts(kind, byStatus)
  const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0)

  return (
    <HomeSection
      id={`home-${kind}s`}
      icon={Icon}
      title={copy.title}
      link={total > 0 ? { href: copy.base, label: "All" } : null}
    >
      {total === 0 ? (
        <EmptyState
          icon={Icon}
          title={copy.empty}
          description={copy.emptyText}
          action={
            <Button asChild size="sm" className="h-11 sm:h-8">
              <Link href={`${copy.base}/new`}>
                <Plus aria-hidden="true" />
                {copy.newLabel}
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-3 rounded-xl border bg-card p-4 shadow-xs">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">{counts.live}</span>{" "}
            {kind === "idea" ? "open" : "looking for creators"} ·{" "}
            <span className="tabular-nums">{counts.draft}</span> draft ·{" "}
            <span className="tabular-nums">{counts.in_collab}</span> in a collab
          </p>
          <ul className="divide-y">
            {items.slice(0, 3).map((item) => (
              <li key={item.id}>
                <Link
                  href={`${copy.base}/${item.id}`}
                  className="flex min-h-11 items-center gap-3 py-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                  <SupplyStatusBadge kind={kind} status={item.status} />
                </Link>
              </li>
            ))}
          </ul>
          <Button asChild variant="outline" size="sm" className="h-11 w-full sm:h-8 sm:w-auto">
            <Link href={`${copy.base}/new`}>
              <Plus aria-hidden="true" />
              {copy.newLabel}
            </Link>
          </Button>
        </div>
      )}
    </HomeSection>
  )
}
