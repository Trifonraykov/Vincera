import type { LucideIcon } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"

/** A titled block on `/app` with an optional "see all" link (44 px on touch screens). */
export function HomeSection({
  id,
  icon: Icon,
  title,
  link,
  children,
}: {
  id: string
  icon: LucideIcon
  title: string
  link?: { href: string; label: string } | null
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id={id} className="flex items-center gap-2 font-semibold">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          {title}
        </h2>
        {link ? (
          <Button asChild variant="ghost" size="sm" className="h-11 sm:h-8">
            <Link href={link.href}>{link.label}</Link>
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  )
}
