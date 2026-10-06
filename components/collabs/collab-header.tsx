import { Lightbulb, Package } from "lucide-react"

import { AppBarSlot } from "@/components/layout/app-bar-slot"
import type { CollabSummary } from "@/lib/collabs/queries"
import { COLLAB_ROLE_LABELS } from "@/lib/collabs/display"

import { CollabNav, type CollabSection } from "./collab-nav"
import { CollabStageBadge } from "./stage-badge"

/**
 * The top of every collab page: what it is about, with whom, the stage, and the section links.
 * Sets the phone app bar's title and back target (the collab list from the overview, the overview
 * from a section).
 */
export function CollabHeader({
  collab,
  viewerId,
  section,
  badges,
  appBarAction,
}: {
  collab: CollabSummary
  viewerId: string
  section: CollabSection
  badges?: Parameters<typeof CollabNav>[0]["badges"]
  appBarAction?: React.ReactNode
}) {
  const KindIcon = collab.target.kind === "idea" ? Lightbulb : Package
  const partners = collab.members.filter((member) => member.userId !== viewerId)
  const isMember = partners.length < collab.members.length
  const sectionTitles: Record<CollabSection, string> = {
    overview: "Collab",
    agreement: "Agreement",
    tasks: "Tasks",
    messages: "Messages",
    launch: "Launch",
    analytics: "Analytics",
  }
  return (
    <div className="space-y-4">
      <AppBarSlot
        title={sectionTitles[section]}
        back={section === "overview" ? "/app/collabs" : `/app/collabs/${collab.id}`}
        action={appBarAction}
      />
      <div className="space-y-2">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <KindIcon className="size-4" aria-hidden="true" />
          <span>{collab.target.kind === "idea" ? "Idea" : "Product"}</span>
          <span aria-hidden="true">·</span>
          <span>
            {isMember ? "With " : ""}
            {partners
              .map(
                (partner) => `${partner.name} (${COLLAB_ROLE_LABELS[partner.role].toLowerCase()})`,
              )
              .join(", ")}
          </span>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-balance break-words">
          {collab.target.title}
        </h1>
        <CollabStageBadge stage={collab.stage} />
      </div>
      <CollabNav collabId={collab.id} current={section} badges={badges} />
    </div>
  )
}
