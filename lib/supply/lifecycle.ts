import type { IdeaStatus, ProductStatus } from "@/lib/db/schema/enums"

/**
 * The lifecycle of ideas (creators) and products (builders), as one pure state machine
 * (CLAUDE.md §19.24 "Ideas and products", §19.25). Client-safe: pages use it to decide which
 * buttons to show; the server actions use `statusesAllowing` in their conditional updates, so a
 * racing change loses cleanly.
 *
 * Owner actions:
 * - `edit`: in draft and while published (idea `open`, product `seeking`).
 * - `publish`: draft → open / seeking (sets `published_at`).
 * - `archive`: draft or published → archived (sets `archived_at`).
 * - `restore`: archived → draft (clears `archived_at`).
 *
 * `in_collab` and `launched` are locked for the owner: nothing can be edited or archived while a
 * collab depends on the row (the collab moves it on: `in_collab → launched` in Phase 4, back to
 * open/seeking when a collab ends before launch in Phase 6). A non-exclusive product stays
 * `seeking` during its collabs, so it remains editable and archivable; archiving it only stops new
 * proposals (the collabs keep their agreed terms).
 */

export type SupplyKind = "idea" | "product"
export type SupplyStatus = IdeaStatus | ProductStatus
export type StatusOf<K extends SupplyKind> = K extends "idea" ? IdeaStatus : ProductStatus

/** The published status: visible to the other side and to matching. */
export const LIVE_STATUS = { idea: "open", product: "seeking" } as const satisfies {
  idea: IdeaStatus
  product: ProductStatus
}

export type SupplyAction = "edit" | "publish" | "archive" | "restore"
export const SUPPLY_ACTIONS = [
  "edit",
  "publish",
  "archive",
  "restore",
] as const satisfies readonly SupplyAction[]

type Phase = "draft" | "live" | "in_collab" | "launched" | "archived"

const PHASE_ACTIONS: Record<Phase, readonly SupplyAction[]> = {
  draft: ["edit", "publish", "archive"],
  live: ["edit", "archive"],
  in_collab: [],
  launched: [],
  archived: ["restore"],
}

function phaseOf(kind: SupplyKind, status: SupplyStatus): Phase {
  if (status === LIVE_STATUS[kind]) return "live"
  switch (status) {
    case "draft":
    case "in_collab":
    case "launched":
    case "archived":
      return status
    default:
      // `open` on a product or `seeking` on an idea: not a status of that kind.
      throw new Error(`"${status}" is not a ${kind} status`)
  }
}

/** What the owner may do with a row in `status`. */
export function ownerActions(kind: SupplyKind, status: SupplyStatus): readonly SupplyAction[] {
  return PHASE_ACTIONS[phaseOf(kind, status)]
}

export function canPerform(kind: SupplyKind, status: SupplyStatus, action: SupplyAction): boolean {
  return ownerActions(kind, status).includes(action)
}

/** The status after `action`, or null when it is not allowed from `status`. */
export function nextStatus<K extends SupplyKind>(
  kind: K,
  status: StatusOf<K>,
  action: SupplyAction,
): StatusOf<K> | null {
  if (!canPerform(kind, status, action)) return null
  switch (action) {
    case "edit":
      return status
    case "publish":
      return LIVE_STATUS[kind] as StatusOf<K>
    case "archive":
      return "archived" as StatusOf<K>
    case "restore":
      return "draft" as StatusOf<K>
  }
}

const ALL_STATUSES: Record<SupplyKind, readonly SupplyStatus[]> = {
  idea: ["draft", "open", "in_collab", "launched", "archived"],
  product: ["draft", "seeking", "in_collab", "launched", "archived"],
}

/** Every status `action` may start from, for the `WHERE status IN (…)` of a conditional update. */
export function statusesAllowing<K extends SupplyKind>(
  kind: K,
  action: SupplyAction,
): StatusOf<K>[] {
  return ALL_STATUSES[kind].filter((status) => canPerform(kind, status, action)) as StatusOf<K>[]
}

export function statusesOf<K extends SupplyKind>(kind: K): readonly StatusOf<K>[] {
  return ALL_STATUSES[kind] as readonly StatusOf<K>[]
}

// --- Labels ------------------------------------------------------------------------------------

export const SUPPLY_NOUNS: Record<SupplyKind, string> = { idea: "idea", product: "product" }

export const IDEA_STATUS_LABELS: Record<IdeaStatus, string> = {
  draft: "Draft",
  open: "Open",
  in_collab: "In a collab",
  launched: "Launched",
  archived: "Archived",
}

export const PRODUCT_STATUS_LABELS: Record<ProductStatus, string> = {
  draft: "Draft",
  seeking: "Seeking creators",
  in_collab: "In a collab",
  launched: "Launched",
  archived: "Archived",
}

export function statusLabel(kind: SupplyKind, status: SupplyStatus): string {
  return kind === "idea"
    ? IDEA_STATUS_LABELS[status as IdeaStatus]
    : PRODUCT_STATUS_LABELS[status as ProductStatus]
}

/** One sentence under the status badge: who sees it and what can be done. */
export function statusExplanation(kind: SupplyKind, status: SupplyStatus): string {
  const noun = SUPPLY_NOUNS[kind]
  const otherSide = kind === "idea" ? "builders" : "creators"
  switch (phaseOf(kind, status)) {
    case "draft":
      return `Only you can see this draft. Publish it when it's ready for ${otherSide}.`
    case "live":
      return `${otherSide[0]?.toUpperCase()}${otherSide.slice(1)} can find this ${noun} and send you proposals.`
    case "in_collab":
      return `This ${noun} is part of a collab, so it can't be changed or archived.`
    case "launched":
      return `This ${noun} has launched, so it can't be changed or archived.`
    case "archived":
      return `Archived: hidden from ${otherSide}. Restore it as a draft to work on it again.`
  }
}

/** Why an action is refused, in plain language (the action's error message). */
export function refusalMessage(
  kind: SupplyKind,
  status: SupplyStatus,
  action: SupplyAction,
): string {
  const noun = SUPPLY_NOUNS[kind]
  const phase = phaseOf(kind, status)
  if (phase === "in_collab") return `This ${noun} is part of a collab, so it can't be changed.`
  if (phase === "launched") return `This ${noun} has launched, so it can't be changed.`
  switch (action) {
    case "edit":
      return `This ${noun} is archived. Restore it to edit it.`
    case "publish":
      return phase === "live"
        ? `This ${noun} is already published.`
        : `Restore this ${noun} before publishing it.`
    case "archive":
      return `This ${noun} is already archived.`
    case "restore":
      return `Only archived ${noun}s can be restored.`
  }
}

// --- List filters ------------------------------------------------------------------------------

/** The status filter of `/app/ideas` and `/app/products` (`?status=`). */
export type SupplyFilter = "all" | "draft" | "live" | "in_collab" | "launched" | "archived"
export const SUPPLY_FILTERS = [
  "all",
  "draft",
  "live",
  "in_collab",
  "launched",
  "archived",
] as const satisfies readonly SupplyFilter[]

/** "all" is every status but archived (archived rows have their own filter). */
export function statusesForFilter<K extends SupplyKind>(
  kind: K,
  filter: SupplyFilter,
): StatusOf<K>[] {
  if (filter === "all") {
    return statusesOf(kind).filter((status) => status !== "archived") as StatusOf<K>[]
  }
  if (filter === "live") return [LIVE_STATUS[kind] as StatusOf<K>]
  return [filter as StatusOf<K>]
}

export function filterLabel(kind: SupplyKind, filter: SupplyFilter): string {
  switch (filter) {
    case "all":
      return "All"
    case "draft":
      return "Drafts"
    case "live":
      return kind === "idea" ? "Open" : "Seeking"
    case "in_collab":
      return "In a collab"
    case "launched":
      return "Launched"
    case "archived":
      return "Archived"
  }
}

export function parseSupplyFilter(value: string | string[] | undefined): SupplyFilter {
  const raw = Array.isArray(value) ? value[0] : value
  return (SUPPLY_FILTERS as readonly string[]).includes(raw ?? "") ? (raw as SupplyFilter) : "all"
}

/** Each filter's count from per-status counts ("all" leaves archived rows out). */
export function filterCounts(
  kind: SupplyKind,
  byStatus: Partial<Record<SupplyStatus, number>>,
): Record<SupplyFilter, number> {
  const counts: Record<SupplyFilter, number> = {
    all: 0,
    draft: 0,
    live: 0,
    in_collab: 0,
    launched: 0,
    archived: 0,
  }
  for (const status of ALL_STATUSES[kind]) {
    const total = byStatus[status] ?? 0
    const phase = phaseOf(kind, status)
    counts[phase] += total
    if (phase !== "archived") counts.all += total
  }
  return counts
}
