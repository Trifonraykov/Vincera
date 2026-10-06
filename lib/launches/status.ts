import type { CollabStage, LaunchStatus } from "@/lib/db/schema/enums"

/**
 * The launch status machine (§12; CLAUDE.md §19.31 "Launch status machine"). Pure and
 * client-safe: the launch builder's writes (lib/launches) apply it with conditional updates, and
 * pages use it to show what each member can do. Owner: the launch builder (who may extend it in
 * §19.31 terms; the contract below is what the checkout, ledger and payouts builders rely on).
 *
 *   draft ──approve (first)──▶ pending_approval ──approve (both)──▶ admin_review ──admin_approve──▶ live
 *     ▲                              │      └──────── (AUTO_APPROVE_LAUNCHES) ───────────────────────▶ live
 *     └────── save / admin_reject ───┴───────────────── admin_review                                    │
 *   live ──pause──▶ paused ──resume (both approvals of the current version)──▶ live                      │
 *   paused ──save──▶ draft (AUTO_APPROVE_LAUNCHES off: the edited version is reviewed again)          │
 *   any but ended ──end──▶ ended (an admin, or the collab ending; buyers keep their access)  ◀───────────┘
 */

export type LaunchAction =
  /** A member saved the setup: approvals reset (§12). */
  | "save"
  /** A member approved the current version. */
  | "approve"
  | "admin_approve"
  | "admin_reject"
  | "pause"
  | "resume"
  | "end"

export type LaunchTransitionContext = {
  /** After this approval, every member has approved the current version. */
  allMembersApproved?: boolean
  /**
   * `AUTO_APPROVE_LAUNCHES` (§17): both approvals go straight to `live`, and an edit of a paused
   * launch keeps it paused (both approvals re-arm "Resume"). Without it, an edit of a paused
   * launch sends it back to `draft`, so the new version passes admin review again.
   */
  autoApprove?: boolean
}

/** The status after `action`, or null when the action is not allowed in `status`. */
export function launchStatusAfter(
  status: LaunchStatus,
  action: LaunchAction,
  context: LaunchTransitionContext = {},
): LaunchStatus | null {
  switch (action) {
    case "save":
      // A paused launch was reviewed once; a changed version must be reviewed again before it
      // sells (§12, CLAUDE.md §19.37): back to draft, unless members' approvals are the gate.
      if (status === "paused") return context.autoApprove ? "paused" : "draft"
      return status === "draft" || status === "pending_approval" || status === "admin_review"
        ? "draft"
        : null
    case "approve":
      if (status === "paused") return "paused" // resuming is a separate action
      if (status !== "draft" && status !== "pending_approval") return null
      if (!context.allMembersApproved) return "pending_approval"
      return context.autoApprove ? "live" : "admin_review"
    case "admin_approve":
      return status === "admin_review" ? "live" : null
    case "admin_reject":
      return status === "admin_review" ? "draft" : null
    case "pause":
      return status === "live" ? "paused" : null
    case "resume":
      return status === "paused" ? "live" : null
    case "end":
      return status === "ended" ? null : "ended"
  }
}

/**
 * The collab stage that goes with a launch change (§5 `collabs.stage`, via `changeCollabStage`):
 * the collab enters `launch_review` when the launch first leaves `draft`, goes back to `building`
 * when the launch returns to `draft`, and becomes `live` when the launch first goes live. Paused
 * and ended launches leave the stage alone (the collab ending is Phase 6's, and ends the launch).
 * Null = no change.
 */
export function collabStageForLaunch(
  collabStage: CollabStage,
  launchStatus: LaunchStatus,
): CollabStage | null {
  if (
    collabStage === "building" &&
    (launchStatus === "pending_approval" || launchStatus === "admin_review")
  ) {
    return "launch_review"
  }
  if (collabStage === "launch_review" && launchStatus === "draft") return "building"
  if (collabStage === "launch_review" && launchStatus === "live") return "live"
  return null
}

/** Buyers can start a checkout only while the launch is live. */
export function isSellable(status: LaunchStatus): boolean {
  return status === "live"
}

/**
 * `/p/[slug]` is public for these statuses (paused and ended show "not available"). A launch that
 * went live once stays public in every status (`isPublicLaunch`): one sent back to review after an
 * edit shows "not available" too, so its tracked links keep working.
 */
export const PUBLIC_LAUNCH_STATUSES = [
  "live",
  "paused",
  "ended",
] as const satisfies readonly LaunchStatus[]

export const LAUNCH_STATUS_LABELS = {
  draft: "Draft",
  pending_approval: "Waiting for approval",
  admin_review: "In review",
  live: "Live",
  paused: "Paused",
  ended: "Ended",
} as const satisfies Record<LaunchStatus, string>

/** Whether the product page, tracked links and images of a launch are public. */
export function isPublicLaunch(launch: { status: LaunchStatus; wentLiveAt: Date | null }): boolean {
  return (
    (PUBLIC_LAUNCH_STATUSES as readonly string[]).includes(launch.status) ||
    launch.wentLiveAt !== null
  )
}

/** The status the product page shows: a launch back in review after an edit reads as paused. */
export function publicLaunchStatus(status: LaunchStatus): (typeof PUBLIC_LAUNCH_STATUSES)[number] {
  return status === "live" || status === "ended" ? status : "paused"
}
