import { CircleCheck, Clock, Scale } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { DisputeStatus } from "@/lib/db/schema/enums"
import {
  DISPUTE_KIND_LABELS,
  DISPUTE_OUTCOME_LABELS,
  DISPUTE_STATUS_DESCRIPTIONS,
  DISPUTE_STATUS_LABELS,
} from "@/lib/disputes/fields"
import type { CollabDisputeItem } from "@/lib/disputes/service"
import { formatExact } from "@/lib/proposals/display"

import { RaiseDisputeSheet } from "./raise-dispute-sheet"

const STATUS_ICONS: Record<DisputeStatus, typeof Clock> = {
  open: Clock,
  in_review: Scale,
  resolved: CircleCheck,
}

/**
 * The collab overview's disputes section (`id="disputes"`, CLAUDE.md §19.38): each dispute's kind,
 * who raised it, its status and, once resolved, the outcome and our team's note. Members can raise
 * one when `canRaise` (no unresolved dispute of their own on this collab). Descriptions are plain
 * text (`whitespace-pre-wrap`), never Markdown or HTML.
 */
export function DisputesCard({
  collabId,
  disputes,
  viewerId,
  memberNames,
  canRaise,
  isMember,
}: {
  collabId: string
  disputes: CollabDisputeItem[]
  viewerId: string
  memberNames: ReadonlyMap<string, string>
  canRaise: boolean
  isMember: boolean
}) {
  if (!isMember && disputes.length === 0) return null
  return (
    <section id="disputes" aria-labelledby="disputes-heading" className="scroll-mt-24 space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 id="disputes-heading" className="font-semibold">
          Disputes
        </h2>
        {canRaise ? <RaiseDisputeSheet collabId={collabId} /> : null}
      </div>
      {disputes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          If something goes wrong that you can&apos;t settle in the messages (the split, delivery,
          or leaving the collab), raise a dispute and our team will look into it.
        </p>
      ) : (
        <ul className="space-y-3">
          {disputes.map((dispute) => {
            const Icon = STATUS_ICONS[dispute.status]
            const raisedBy =
              dispute.raisedByUserId === viewerId
                ? "you"
                : (memberNames.get(dispute.raisedByUserId) ?? "your collaborator")
            return (
              <li
                key={dispute.id}
                data-dispute-status={dispute.status}
                className="space-y-2 rounded-xl border bg-card p-4 text-sm shadow-xs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span className="font-medium">{DISPUTE_KIND_LABELS[dispute.kind]}</span>
                  <Badge variant={dispute.status === "resolved" ? "secondary" : "outline"}>
                    {DISPUTE_STATUS_LABELS[dispute.status]}
                  </Badge>
                </div>
                <p className="text-muted-foreground">
                  Raised by {raisedBy} · {formatExact(dispute.createdAt)}
                </p>
                <p className="break-words whitespace-pre-wrap">{dispute.description}</p>
                {dispute.status === "resolved" && dispute.outcome ? (
                  <div className="space-y-1 rounded-lg bg-muted/50 p-3">
                    <p className="font-medium">
                      {DISPUTE_OUTCOME_LABELS[dispute.outcome]}
                      {dispute.resolvedAt ? ` · ${formatExact(dispute.resolvedAt)}` : null}
                    </p>
                    {dispute.resolutionNote ? (
                      <p className="break-words whitespace-pre-wrap">{dispute.resolutionNote}</p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    {DISPUTE_STATUS_DESCRIPTIONS[dispute.status]}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
