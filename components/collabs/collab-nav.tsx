import { FileSignature, LayoutDashboard, ListChecks, MessagesSquare, Rocket } from "lucide-react"
import Link from "next/link"

import { cn } from "@/lib/utils"

export type CollabSection = "overview" | "agreement" | "tasks" | "messages" | "launch"

const SECTIONS: { id: CollabSection; title: string; path: string; icon: typeof ListChecks }[] = [
  { id: "overview", title: "Overview", path: "", icon: LayoutDashboard },
  { id: "agreement", title: "Agreement", path: "/agreement", icon: FileSignature },
  { id: "tasks", title: "Tasks", path: "/tasks", icon: ListChecks },
  { id: "messages", title: "Messages", path: "/messages", icon: MessagesSquare },
  { id: "launch", title: "Launch", path: "/launch", icon: Rocket },
]

/**
 * The collab's sections (§12 `/app/collabs/[id]`, `/agreement`, `/tasks`, `/messages`) as links,
 * each with its own URL. On phones the row scrolls sideways inside itself (never the page) and
 * every link is a 44 px target. Launch joined it in Phase 4; analytics joins it in Phase 7.
 */
export function CollabNav({
  collabId,
  current,
  badges = {},
}: {
  collabId: string
  current: CollabSection
  /** Small counts next to a section (open tasks, unread messages). */
  badges?: Partial<Record<CollabSection, { count: number; label: string }>>
}) {
  return (
    <nav aria-label="Collab sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b">
        {SECTIONS.map((section) => {
          const active = section.id === current
          const badge = badges[section.id]
          const Icon = section.icon
          return (
            <li key={section.id}>
              <Link
                href={`/app/collabs/${collabId}${section.path}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {section.title}
                {badge && badge.count > 0 ? (
                  <span
                    className="rounded-full bg-muted px-1.5 text-xs tabular-nums"
                    aria-label={badge.label}
                  >
                    {badge.count}
                  </span>
                ) : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
