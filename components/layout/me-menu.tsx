import { ChevronRight, type LucideIcon } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { isBuiltRoute, type MeSection } from "@/lib/nav"
import { cn } from "@/lib/utils"

/**
 * The Me page's grouped lists (`/app/me`), like a phone's settings screen: one rounded group per
 * section, full-width rows of at least 48 px with an icon, a title and a chevron. Pages a later
 * phase builds are listed dimmed, unlinked, with a "Soon" badge (the sidebar does the same).
 */
export function MeMenuSections({ sections }: { sections: readonly MeSection[] }) {
  return (
    <>
      {sections.map((section) => (
        <MeMenuGroup key={section.label} label={section.label}>
          {section.items.map((item) => (
            <MeMenuRow
              key={item.href}
              icon={item.icon}
              title={item.title}
              href={isBuiltRoute(item.href) ? item.href : undefined}
            />
          ))}
        </MeMenuGroup>
      ))}
    </>
  )
}

export function MeMenuGroup({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  const id = `me-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  return (
    <section aria-labelledby={id} className={cn("space-y-2", className)}>
      <h2
        id={id}
        className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        {label}
      </h2>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">{children}</ul>
    </section>
  )
}

/** One row: a link, or (without `href`) a page that is coming soon. `trailing` replaces the chevron. */
export function MeMenuRow({
  icon: Icon,
  title,
  description,
  href,
  trailing,
}: {
  icon: LucideIcon
  title: string
  description?: string
  href?: string
  trailing?: ReactNode
}) {
  const content = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        {description ? (
          <span className="block truncate text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
      {trailing ??
        (href ? (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <Badge variant="secondary">
            <span aria-hidden="true">Soon</span>
            <span className="sr-only">(coming soon)</span>
          </Badge>
        ))}
    </>
  )
  const rowClass = "flex min-h-12 items-center gap-3 px-3 py-2"

  return (
    <li>
      {href ? (
        <Link
          href={href}
          className={cn(
            rowClass,
            "transition-colors outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset active:bg-accent motion-reduce:transition-none",
          )}
        >
          {content}
        </Link>
      ) : (
        <div className={cn(rowClass, "text-muted-foreground")} data-coming-soon="">
          {content}
        </div>
      )}
    </li>
  )
}
