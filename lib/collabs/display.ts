import type { AgreementStatus, CollabRole, CollabStage } from "@/lib/db/schema/enums"

/**
 * Words for the collab pages (§12 `/app/collabs/*`). Client-safe.
 */

/** The stages in the order a collab goes through them (§5). */
export const COLLAB_STAGE_ORDER = [
  "agreement",
  "building",
  "launch_review",
  "live",
] as const satisfies readonly CollabStage[]

export const COLLAB_STAGE_LABELS: Record<CollabStage, string> = {
  agreement: "Agreement",
  building: "Building",
  launch_review: "Launch review",
  live: "Live",
  ended: "Ended",
}

export const COLLAB_STAGE_DESCRIPTIONS: Record<CollabStage, string> = {
  agreement: "You both sign the agreement before work starts.",
  building: "The agreement is signed: build the product together.",
  launch_review: "The product page is being reviewed before it goes live.",
  live: "The product is on sale.",
  ended: "This collab has ended. Its history stays here.",
}

export const COLLAB_ROLE_LABELS: Record<CollabRole, string> = {
  creator: "Creator",
  builder: "Builder",
}

/** `/app/collabs?stage=`: one stage, "active" (every stage but ended, the default) or "all". */
export type CollabFilter = "active" | "all" | CollabStage
export const COLLAB_FILTERS = [
  "active",
  "agreement",
  "building",
  "launch_review",
  "live",
  "ended",
  "all",
] as const satisfies readonly CollabFilter[]

export function parseCollabFilter(value: unknown): CollabFilter {
  return typeof value === "string" && (COLLAB_FILTERS as readonly string[]).includes(value)
    ? (value as CollabFilter)
    : "active"
}

export function collabFilterLabel(filter: CollabFilter): string {
  if (filter === "active") return "Active"
  if (filter === "all") return "All"
  return COLLAB_STAGE_LABELS[filter]
}

export function matchesCollabFilter(stage: CollabStage, filter: CollabFilter): boolean {
  if (filter === "all") return true
  if (filter === "active") return stage !== "ended"
  return stage === filter
}

/** What a member should do next, in one short line (lists and the home page). */
export function collabNextStep(input: {
  stage: CollabStage
  agreementStatus: AgreementStatus | null
  signedByViewer: boolean
  openTasks: number
}): { text: string; needsViewer: boolean } {
  switch (input.stage) {
    case "agreement":
      if (input.agreementStatus === "awaiting_signatures" && !input.signedByViewer) {
        return { text: "Sign the agreement", needsViewer: true }
      }
      return { text: "Waiting for your collaborator to sign", needsViewer: false }
    case "building":
      return input.openTasks > 0
        ? {
            text: `${input.openTasks} open ${input.openTasks === 1 ? "task" : "tasks"}`,
            needsViewer: false,
          }
        : { text: "Plan the work in Tasks", needsViewer: false }
    case "launch_review":
      return { text: "Launch in review", needsViewer: false }
    case "live":
      return { text: "On sale", needsViewer: false }
    case "ended":
      return { text: "Ended", needsViewer: false }
  }
}
