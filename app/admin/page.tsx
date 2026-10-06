import {
  Banknote,
  Handshake,
  ListChecks,
  Rocket,
  Scale,
  ShieldAlert,
  Undo2,
  Users,
  type LucideIcon,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import type { ReactNode } from "react"

import { PageHeader } from "@/components/shared/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { STAGE_TEXT } from "@/lib/admin/fields"
import { loadAdminOverview } from "@/lib/admin/queries"
import { canAccessAdmin } from "@/lib/auth/authz"
import { authorizePage, requireAdmin } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { formatMoney } from "@/lib/money"
import { isBuiltRoute } from "@/lib/nav"

export const metadata: Metadata = { title: "Overview" }

type Stat = {
  label: string
  href: string
  icon: LucideIcon
  value: ReactNode
  hint: ReactNode
  attention?: boolean
}

/**
 * Admin overview (§12 `/admin`, Phase 6; CLAUDE.md §19.39): the platform's key counts, each
 * linking to the page that acts on it. Counts that need someone's attention are highlighted.
 */
export default async function AdminOverviewPage() {
  const user = await requireAdmin()
  authorizePage(canAccessAdmin(user), "/app")
  const overview = await loadAdminOverview(getDb())
  const activeCollabs = Object.values(overview.collabsByStage).reduce((a, b) => a + b, 0)
  const gmv =
    overview.gmv30d.length === 0
      ? formatMoney(0, "eur")
      : overview.gmv30d.map((row) => formatMoney(row.grossCents, row.currency)).join(" · ")
  const orders30d = overview.gmv30d.reduce((total, row) => total + row.orders, 0)

  const stats: Stat[] = [
    {
      label: "Users",
      href: "/admin/users",
      icon: Users,
      value: overview.users.total,
      hint: `${overview.users.creators} creators · ${overview.users.builders} builders · ${overview.users.admins} admins${overview.users.suspended ? ` · ${overview.users.suspended} suspended` : ""}`,
    },
    {
      label: "Active collabs",
      href: "/admin/collabs",
      icon: Handshake,
      value: activeCollabs,
      hint: (Object.keys(overview.collabsByStage) as (keyof typeof overview.collabsByStage)[])
        .map((stage) => `${overview.collabsByStage[stage]} ${STAGE_TEXT[stage].toLowerCase()}`)
        .join(" · "),
    },
    {
      label: "Live launches",
      href: "/admin/launches?tab=live",
      icon: Rocket,
      value: overview.liveLaunches,
      hint: "Selling right now",
    },
    {
      label: "Sales, last 30 days",
      href: "/admin/payouts",
      icon: Banknote,
      value: gmv,
      hint: `${orders30d} ${orders30d === 1 ? "order" : "orders"} (gross, VAT included)`,
    },
    {
      label: "Launches to review",
      href: "/admin/launches",
      icon: ListChecks,
      value: overview.pendingReviews.launches,
      hint: "Approved by both members",
      attention: overview.pendingReviews.launches > 0,
    },
    {
      label: "Manual entries to verify",
      href: "/admin/users",
      icon: ShieldAlert,
      value: overview.pendingReviews.manualConnections,
      hint: "Follower counts typed by creators",
      attention: overview.pendingReviews.manualConnections > 0,
    },
    {
      label: "Open disputes",
      href: "/admin/disputes",
      icon: Scale,
      value: overview.openDisputes,
      hint: "Open or in review",
      attention: overview.openDisputes > 0,
    },
    {
      label: "Payout failures",
      href: "/admin/payouts#failed",
      icon: Banknote,
      value: overview.payoutFailures30d,
      hint: "Refused transfers, last 30 days",
      attention: overview.payoutFailures30d > 0,
    },
    {
      label: "Refund requests",
      href: "/admin/payouts#refund-requests",
      icon: Undo2,
      value: overview.pendingRefundRequests,
      hint: "Waiting for a decision",
      attention: overview.pendingRefundRequests > 0,
    },
  ]

  return (
    <div className="space-y-8">
      <PageHeader
        title="Admin overview"
        description="Platform health at a glance. Every admin action is written to the audit log."
      />
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map(({ label, href, icon: Icon, value, hint, attention }) => {
          const card = (
            <Card
              className={
                attention
                  ? "h-full gap-2 border-amber-400 transition-colors hover:bg-accent/50 dark:border-amber-700"
                  : "h-full gap-2 transition-colors hover:bg-accent/50"
              }
            >
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium">{label}</CardTitle>
                <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold break-words tabular-nums">{value}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </CardContent>
            </Card>
          )
          const path = href.split(/[?#]/)[0] ?? href
          return (
            <li key={label}>
              {isBuiltRoute(path) ? (
                <Link
                  href={href}
                  className="block h-full rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {card}
                </Link>
              ) : (
                card
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
