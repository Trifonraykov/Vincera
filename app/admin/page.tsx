import { Banknote, Handshake, ListChecks, Scale, Users, type LucideIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { requireAdmin } from "@/lib/auth/session"

export const metadata: Metadata = { title: "Overview" }

type Stat = { label: string; href: string; icon: LucideIcon; hint: string }

/** Overview placeholders (§16 Phase 6 fills them with live numbers). */
const STATS: Stat[] = [
  { label: "Users", href: "/admin/users", icon: Users, hint: "Sign-ups and suspensions" },
  { label: "Active collabs", href: "/admin/collabs", icon: Handshake, hint: "Agreement to live" },
  {
    label: "Launches to review",
    href: "/admin/launches",
    icon: ListChecks,
    hint: "Approved by both members",
  },
  { label: "Open disputes", href: "/admin/disputes", icon: Scale, hint: "Splits, delivery, exits" },
  { label: "Payouts due", href: "/admin/payouts", icon: Banknote, hint: "Past the hold period" },
]

export default async function AdminOverviewPage() {
  await requireAdmin()

  return (
    <div className="space-y-8">
      <PageHeader
        title="Admin overview"
        description="Platform health at a glance. Every admin action is written to the audit log."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {STATS.map(({ label, href, icon: Icon, hint }) => (
          <Link
            key={href}
            href={href}
            className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Card className="h-full gap-2 transition-colors hover:bg-accent/50">
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium">{label}</CardTitle>
                <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tabular-nums">—</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
      <EmptyState
        icon={ListChecks}
        title="Nothing needs attention"
        description="Launches awaiting review, new disputes and failed payouts will be listed here."
      />
    </div>
  )
}
