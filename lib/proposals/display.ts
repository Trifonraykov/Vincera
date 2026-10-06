import type { ProposalStatus } from "@/lib/db/schema/enums"

/**
 * What the proposal pages show about statuses and revisions. Pure and client-safe.
 */

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: "Waiting for an answer",
  countered: "Countered",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  withdrawn: "Withdrawn",
}

export type ProposalTab = "received" | "sent" | "closed"
export const PROPOSAL_TABS = ["received", "sent", "closed"] as const satisfies ProposalTab[]
export const PROPOSAL_TAB_LABELS: Record<ProposalTab, string> = {
  received: "Received",
  sent: "Sent",
  closed: "Closed",
}

export function parseProposalTab(value: unknown): ProposalTab {
  return typeof value === "string" && (PROPOSAL_TABS as readonly string[]).includes(value)
    ? (value as ProposalTab)
    : "received"
}

/** The parts of a revision the history compares. */
export type RevisionTerms = {
  scope: string
  message: string | null
  creatorSplitPct: number
  builderSplitPct: number
  timelineWeeks: number
}

export type RevisionChange = "split" | "timelineWeeks" | "scope"

/**
 * What a counter-offer changed compared with the offer before it, for highlighting in the
 * history. The first revision changes nothing (there is nothing to compare). The message is a
 * note to the other party, not a term, so it never counts as a change.
 */
export function revisionChanges(
  previous: RevisionTerms | null,
  next: RevisionTerms,
): RevisionChange[] {
  if (!previous) return []
  const changes: RevisionChange[] = []
  if (
    previous.creatorSplitPct !== next.creatorSplitPct ||
    previous.builderSplitPct !== next.builderSplitPct
  ) {
    changes.push("split")
  }
  if (previous.timelineWeeks !== next.timelineWeeks) changes.push("timelineWeeks")
  if (previous.scope.trim() !== next.scope.trim()) changes.push("scope")
  return changes
}

/** "in 3 days", "in 5 hours", "in less than an hour", or "now" for times already past. */
export function formatTimeLeft(until: Date, from: Date): string {
  const ms = until.getTime() - from.getTime()
  if (ms <= 0) return "now"
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return "in less than an hour"
  if (hours < 48) return hours === 1 ? "in 1 hour" : `in ${hours} hours`
  const days = Math.floor(hours / 24)
  return `in ${days} days`
}

const shortDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
})
const longDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" })
const timeOfDay = new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: "UTC" })

/**
 * "just now", "5 min ago", "3 h ago", "yesterday", "4 Oct", "4 Oct 2025": for lists and threads.
 * Fixed locale and UTC, so it reads the same wherever it renders.
 */
export function formatRelative(date: Date, from: Date): string {
  const seconds = Math.round((from.getTime() - date.getTime()) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  if (hours < 48) return "yesterday"
  return date.getUTCFullYear() === from.getUTCFullYear()
    ? shortDate.format(date)
    : longDate.format(date)
}

/** "5 Oct 2026, 14:03 UTC": the exact time, for `title` / `dateTime` attributes. */
export function formatExact(date: Date): string {
  return `${longDate.format(date)}, ${timeOfDay.format(date)} UTC`
}
