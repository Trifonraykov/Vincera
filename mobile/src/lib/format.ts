/** Display helpers. Money is integer minor units (cents) everywhere (§0). */

export function formatMoney(cents: number | null | undefined, currency = "eur"): string {
  if (cents === null || cents === undefined) return "No price"
  try {
    return new Intl.NumberFormat("en-IE", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ""
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

/** "3 min ago", "yesterday", "12 Oct". */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return "yesterday"
  if (days < 7) return `${days} days ago`
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

/** "in 5 days", "in 3 hours", "expired". */
export function formatTimeLeft(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return "expired"
  const hours = Math.round(diff / 3_600_000)
  if (hours < 24) return `in ${Math.max(hours, 1)} h`
  return `in ${Math.round(hours / 24)} days`
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`
  return String(value)
}

export const FORMAT_LABELS: Record<string, string> = {
  app: "App",
  tool: "Tool",
  template: "Template",
  ai_utility: "AI utility",
  course_tool: "Course tool",
  other: "Other",
}

export const STAGE_LABELS: Record<string, string> = {
  idea: "Idea",
  prototype: "Prototype",
  beta: "Beta",
  live: "Live",
}

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  open: "Open",
  seeking: "Seeking a creator",
  in_collab: "In a collab",
  launched: "Launched",
  archived: "Archived",
  pending: "Waiting for an answer",
  countered: "Countered",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  withdrawn: "Withdrawn",
}

export const COLLAB_STAGE_LABELS: Record<string, string> = {
  agreement: "Agreement",
  building: "Building",
  launch_review: "Launch review",
  live: "Live",
  ended: "Ended",
}

export const SIZE_TIER_LABELS: Record<string, string> = {
  nano: "Nano (under 10K)",
  micro: "Micro (10K–100K)",
  mid: "Mid (100K–500K)",
  macro: "Macro (500K+)",
}

export const FEATURE_LABELS: Record<string, string> = {
  semantic: "Similar focus",
  topic_overlap: "Shared topics",
  audience_fit: "Audience fit",
  format_fit: "Format fit",
  stage_fit: "Stage fit",
  price_fit: "Price fit",
  reliability: "Track record",
}

export function scoreLabel(score: number): string {
  const percent = Math.round(score * 100)
  const band = score >= 0.7 ? "Great fit" : score >= 0.5 ? "Good fit" : "Possible fit"
  return `${percent}% · ${band}`
}
