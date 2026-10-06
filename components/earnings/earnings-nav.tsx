import Link from "next/link"

import { cn } from "@/lib/utils"

const LINKS = [
  { key: "overview", title: "Overview", href: "/app/earnings" },
  { key: "payouts", title: "Payouts", href: "/app/earnings/payouts" },
] as const

/** Tabs between the two earnings pages (§12 `/app/earnings`, `/app/earnings/payouts`). */
export function EarningsNav({ current }: { current: (typeof LINKS)[number]["key"] }) {
  return (
    <nav aria-label="Earnings">
      <ul className="flex gap-1 border-b">
        {LINKS.map((link) => {
          const active = link.key === current
          return (
            <li key={link.key}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-11 items-center border-b-2 px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:h-10",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {link.title}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
