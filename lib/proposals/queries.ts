import "server-only"

import { and, asc, desc, eq, inArray, lt, ne, notInArray, or, sql, type SQL } from "drizzle-orm"

import {
  OPEN_PROPOSAL_STATUSES,
  type ProposalAccess,
  type ProposalRecipient,
  type ProposalTarget,
} from "@/lib/auth/authz"
import type { DbOrTx } from "@/lib/db/client"
import {
  builderProfiles,
  collabs,
  creatorProfiles,
  ideas,
  products,
  proposalRevisions,
  proposals,
  threads,
  users,
  type CollabRole,
  type IdeaStatus,
  type ProductStatus,
  type ProposalStatus,
} from "@/lib/db/schema"

import type { ProposalTab } from "./display"
import { otherPartyId, partyRole } from "./state"

/**
 * Reads for the proposal pages and actions (CLAUDE.md §19.24 "Proposals"). Callers authorize with
 * the rules in lib/auth/authz.ts on what these return; nothing here filters by permission except
 * the user-scoped lists, which only ever return the user's own proposals.
 */

export type TargetKind = ProposalTarget["kind"]
export type TargetRef = { kind: TargetKind; id: string }

/** An idea or product as a proposal sees it. */
export type ProposalTargetInfo = ProposalTarget & {
  id: string
  title: string
  /** Products only: the builder's preferred share, to start the form from. */
  preferredSplitBuilderPct: number | null
}

/** A person as proposals show them: the profile name of their role in the deal. */
export type PartyInfo = { userId: string; role: CollabRole; name: string; handle: string | null }

const ROLE_FALLBACK_NAMES: Record<CollabRole, string> = {
  creator: "A creator",
  builder: "A builder",
}

/** The idea or product a proposal is (or would be) about; null when it does not exist. */
export async function loadProposalTarget(
  database: DbOrTx,
  target: TargetRef,
  options: { lockForShare?: boolean } = {},
): Promise<ProposalTargetInfo | null> {
  if (target.kind === "idea") {
    const query = database
      .select({
        id: ideas.id,
        title: ideas.title,
        status: ideas.status,
        ownerUserId: creatorProfiles.userId,
      })
      .from(ideas)
      .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
      .where(eq(ideas.id, target.id))
    const [row] = options.lockForShare ? await query.for("share", { of: ideas }) : await query
    return row
      ? {
          kind: "idea",
          id: row.id,
          title: row.title,
          status: row.status,
          ownerUserId: row.ownerUserId,
          preferredSplitBuilderPct: null,
        }
      : null
  }
  const query = database
    .select({
      id: products.id,
      title: products.title,
      status: products.status,
      ownerUserId: builderProfiles.userId,
      preferredSplitBuilderPct: products.preferredSplitBuilderPct,
    })
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .where(eq(products.id, target.id))
  const [row] = options.lockForShare ? await query.for("share", { of: products }) : await query
  return row
    ? {
        kind: "product",
        id: row.id,
        title: row.title,
        status: row.status,
        ownerUserId: row.ownerUserId,
        preferredSplitBuilderPct: row.preferredSplitBuilderPct,
      }
    : null
}

/** What `canSendProposal` needs about the recipient; null for an unknown user. */
export async function loadRecipient(
  database: DbOrTx,
  userId: string,
): Promise<ProposalRecipient | null> {
  const [row] = await database
    .select({
      id: users.id,
      roles: users.roles,
      status: users.status,
      onboardingCompletedAt: users.onboardingCompletedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
  return row ?? null
}

/**
 * Display names for the parties of a deal: the profile of their role in it (a creator's creator
 * profile), else their other profile, else their account name, else "A creator" / "A builder".
 * Never an email address.
 */
export async function loadPartyNames(
  database: DbOrTx,
  parties: readonly { userId: string; role: CollabRole }[],
): Promise<Map<string, PartyInfo>> {
  const ids = [...new Set(parties.map((party) => party.userId))]
  const result = new Map<string, PartyInfo>()
  if (ids.length === 0) return result
  const creatorRows = await database
    .select({
      userId: creatorProfiles.userId,
      name: creatorProfiles.displayName,
      handle: creatorProfiles.handle,
    })
    .from(creatorProfiles)
    .where(inArray(creatorProfiles.userId, ids))
  const builderRows = await database
    .select({
      userId: builderProfiles.userId,
      name: builderProfiles.displayName,
      handle: builderProfiles.handle,
    })
    .from(builderProfiles)
    .where(inArray(builderProfiles.userId, ids))
  const userRows = await database
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, ids))
  const creators = new Map(creatorRows.map((row) => [row.userId, row]))
  const builders = new Map(builderRows.map((row) => [row.userId, row]))
  const accounts = new Map(userRows.map((row) => [row.id, row.name]))
  for (const { userId, role } of parties) {
    const own = role === "creator" ? creators.get(userId) : builders.get(userId)
    const other = role === "creator" ? builders.get(userId) : creators.get(userId)
    const name =
      own?.name.trim() ||
      other?.name.trim() ||
      accounts.get(userId)?.trim() ||
      ROLE_FALLBACK_NAMES[role]
    result.set(userId, { userId, role, name, handle: own?.handle ?? null })
  }
  return result
}

/** Shorten a display value for a notification payload (names ≤ 120, titles ≤ 200). */
export function clip(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`
}

// --- One proposal --------------------------------------------------------------------------------

export type ProposalRevisionRow = {
  id: string
  revisionNumber: number
  authorUserId: string
  message: string | null
  scope: string
  creatorSplitPct: number
  builderSplitPct: number
  timelineWeeks: number
  createdAt: Date
}

/** The proposal row plus its current revision's author and number, as the rules need it. */
export type ProposalState = ProposalAccess & {
  id: string
  ideaId: string | null
  productId: string | null
  currentRevisionId: string | null
  currentRevisionNumber: number | null
  respondedAt: Date | null
  expiresAt: Date
}

/**
 * The proposal and its current revision's author; with `lockForUpdate` (inside a transaction) the
 * proposal row is locked until the transaction ends, so concurrent answers queue up behind it.
 */
export async function loadProposalState(
  database: DbOrTx,
  proposalId: string,
  options: { lockForUpdate?: boolean } = {},
): Promise<ProposalState | null> {
  const query = database
    .select({
      id: proposals.id,
      fromUserId: proposals.fromUserId,
      toUserId: proposals.toUserId,
      status: proposals.status,
      ideaId: proposals.ideaId,
      productId: proposals.productId,
      currentRevisionId: proposals.currentRevisionId,
      currentRevisionAuthorId: proposalRevisions.authorUserId,
      currentRevisionNumber: proposalRevisions.revisionNumber,
      respondedAt: proposals.respondedAt,
      expiresAt: proposals.expiresAt,
    })
    .from(proposals)
    .leftJoin(proposalRevisions, eq(proposalRevisions.id, proposals.currentRevisionId))
    .where(eq(proposals.id, proposalId))
  const [row] = options.lockForUpdate ? await query.for("update", { of: proposals }) : await query
  return row ?? null
}

export function targetRefOf(proposal: Pick<ProposalState, "ideaId" | "productId">): TargetRef {
  if (proposal.ideaId) return { kind: "idea", id: proposal.ideaId }
  if (proposal.productId) return { kind: "product", id: proposal.productId }
  throw new Error("proposal has no target")
}

export type ProposalDetail = {
  id: string
  status: ProposalStatus
  createdAt: Date
  expiresAt: Date
  closedAt: Date | null
  fromUserId: string
  toUserId: string
  access: ProposalAccess
  target: ProposalTargetInfo
  /** Both parties, by user id. */
  parties: Map<string, PartyInfo>
  currentRevisionId: string | null
  /** Oldest first. */
  revisions: ProposalRevisionRow[]
  threadId: string | null
  collabId: string | null
}

/** Everything the proposal page shows; null when the proposal does not exist. */
export async function loadProposalDetail(
  database: DbOrTx,
  proposalId: string,
): Promise<ProposalDetail | null> {
  const [row] = await database
    .select({
      id: proposals.id,
      status: proposals.status,
      createdAt: proposals.createdAt,
      expiresAt: proposals.expiresAt,
      closedAt: proposals.closedAt,
      fromUserId: proposals.fromUserId,
      toUserId: proposals.toUserId,
      ideaId: proposals.ideaId,
      productId: proposals.productId,
      currentRevisionId: proposals.currentRevisionId,
      threadId: threads.id,
      collabId: collabs.id,
    })
    .from(proposals)
    .leftJoin(threads, eq(threads.proposalId, proposals.id))
    .leftJoin(collabs, eq(collabs.proposalId, proposals.id))
    .where(eq(proposals.id, proposalId))
  if (!row) return null
  const target = await loadProposalTarget(database, targetRefOf(row))
  if (!target) return null
  const revisions = await database
    .select({
      id: proposalRevisions.id,
      revisionNumber: proposalRevisions.revisionNumber,
      authorUserId: proposalRevisions.authorUserId,
      message: proposalRevisions.message,
      scope: proposalRevisions.scope,
      creatorSplitPct: proposalRevisions.creatorSplitPct,
      builderSplitPct: proposalRevisions.builderSplitPct,
      timelineWeeks: proposalRevisions.timelineWeeks,
      createdAt: proposalRevisions.createdAt,
    })
    .from(proposalRevisions)
    .where(eq(proposalRevisions.proposalId, proposalId))
    .orderBy(asc(proposalRevisions.revisionNumber))
  const current = revisions.find((revision) => revision.id === row.currentRevisionId) ?? null
  const parties = await loadPartyNames(
    database,
    [row.fromUserId, row.toUserId].map((userId) => ({ userId, role: partyRole(target, userId) })),
  )
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    closedAt: row.closedAt,
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    access: {
      fromUserId: row.fromUserId,
      toUserId: row.toUserId,
      status: row.status,
      currentRevisionAuthorId: current?.authorUserId ?? null,
    },
    target,
    parties,
    currentRevisionId: row.currentRevisionId,
    revisions,
    threadId: row.threadId,
    collabId: row.collabId,
  }
}

// --- Lists ---------------------------------------------------------------------------------------

export type ProposalListItem = {
  id: string
  status: ProposalStatus
  target: { kind: TargetKind; id: string; title: string }
  counterpart: PartyInfo
  /** The user sent the proposal (else received it). */
  sentByUser: boolean
  /** The offer on the table waits for the user's answer. */
  yourTurn: boolean
  revisionNumber: number
  creatorSplitPct: number
  builderSplitPct: number
  timelineWeeks: number
  expiresAt: Date
  updatedAt: Date
  closedAt: Date | null
}

const isOpen = inArray(proposals.status, [...OPEN_PROPOSAL_STATUSES])
const isParty = (userId: string) =>
  or(eq(proposals.fromUserId, userId), eq(proposals.toUserId, userId))

function tabFilter(userId: string, tab: ProposalTab): SQL | undefined {
  switch (tab) {
    case "received":
      return and(isOpen, eq(proposals.toUserId, userId))
    case "sent":
      return and(isOpen, eq(proposals.fromUserId, userId))
    case "closed":
      return and(notInArray(proposals.status, [...OPEN_PROPOSAL_STATUSES]), isParty(userId))
  }
}

const LIST_COLUMNS = {
  id: proposals.id,
  status: proposals.status,
  fromUserId: proposals.fromUserId,
  toUserId: proposals.toUserId,
  ideaId: proposals.ideaId,
  productId: proposals.productId,
  expiresAt: proposals.expiresAt,
  updatedAt: proposals.updatedAt,
  closedAt: proposals.closedAt,
  ideaTitle: ideas.title,
  ideaStatus: ideas.status,
  ideaOwnerUserId: creatorProfiles.userId,
  productTitle: products.title,
  productStatus: products.status,
  productOwnerUserId: builderProfiles.userId,
  revisionNumber: proposalRevisions.revisionNumber,
  authorUserId: proposalRevisions.authorUserId,
  creatorSplitPct: proposalRevisions.creatorSplitPct,
  builderSplitPct: proposalRevisions.builderSplitPct,
  timelineWeeks: proposalRevisions.timelineWeeks,
}

type ListRow = {
  id: string
  status: ProposalStatus
  fromUserId: string
  toUserId: string
  ideaId: string | null
  productId: string | null
  expiresAt: Date
  updatedAt: Date
  closedAt: Date | null
  ideaTitle: string | null
  ideaStatus: IdeaStatus | null
  ideaOwnerUserId: string | null
  productTitle: string | null
  productStatus: ProductStatus | null
  productOwnerUserId: string | null
  revisionNumber: number
  authorUserId: string
  creatorSplitPct: number
  builderSplitPct: number
  timelineWeeks: number
}

function listQuery(database: DbOrTx, where: SQL | undefined) {
  return database
    .select(LIST_COLUMNS)
    .from(proposals)
    .innerJoin(proposalRevisions, eq(proposalRevisions.id, proposals.currentRevisionId))
    .leftJoin(ideas, eq(ideas.id, proposals.ideaId))
    .leftJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
    .leftJoin(products, eq(products.id, proposals.productId))
    .leftJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .where(where)
}

function listRowTarget(row: ListRow): (ProposalTarget & { id: string; title: string }) | null {
  if (row.ideaId && row.ideaTitle && row.ideaStatus && row.ideaOwnerUserId) {
    return {
      kind: "idea",
      id: row.ideaId,
      title: row.ideaTitle,
      status: row.ideaStatus,
      ownerUserId: row.ideaOwnerUserId,
    }
  }
  if (row.productId && row.productTitle && row.productStatus && row.productOwnerUserId) {
    return {
      kind: "product",
      id: row.productId,
      title: row.productTitle,
      status: row.productStatus,
      ownerUserId: row.productOwnerUserId,
    }
  }
  return null
}

async function toListItems(
  database: DbOrTx,
  userId: string,
  rows: readonly ListRow[],
): Promise<ProposalListItem[]> {
  const prepared = rows.flatMap((row) => {
    const target = listRowTarget(row)
    if (!target) return []
    const counterpartId = otherPartyId(row, userId)
    return [{ row, target, counterpartId, role: partyRole(target, counterpartId) }]
  })
  const names = await loadPartyNames(
    database,
    prepared.map((item) => ({ userId: item.counterpartId, role: item.role })),
  )
  return prepared.map(({ row, target, counterpartId, role }) => ({
    id: row.id,
    status: row.status,
    target: { kind: target.kind, id: target.id, title: target.title },
    counterpart: names.get(counterpartId) ?? {
      userId: counterpartId,
      role,
      name: ROLE_FALLBACK_NAMES[role],
      handle: null,
    },
    sentByUser: row.fromUserId === userId,
    yourTurn:
      (OPEN_PROPOSAL_STATUSES as readonly string[]).includes(row.status) &&
      row.authorUserId !== userId,
    revisionNumber: row.revisionNumber,
    creatorSplitPct: row.creatorSplitPct,
    builderSplitPct: row.builderSplitPct,
    timelineWeeks: row.timelineWeeks,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
  }))
}

export const PROPOSAL_LIST_LIMIT = 50

/** Where a page of `/app/proposals` starts: after this row in the tab's order (keyset paging). */
export type ProposalCursor = { at: Date; id: string }

/**
 * The user's proposals on one tab of `/app/proposals`, most recent activity first (closed: by
 * `closed_at`; open: by `updated_at`), a page at a time: `before` continues after the last row of
 * the previous page, and `hasMore` says whether another page follows.
 */
export async function listProposals(
  database: DbOrTx,
  userId: string,
  tab: ProposalTab,
  options: { before?: ProposalCursor; limit?: number } = {},
): Promise<{ items: ProposalListItem[]; hasMore: boolean }> {
  const limit = options.limit ?? PROPOSAL_LIST_LIMIT
  const sortColumn = tab === "closed" ? proposals.closedAt : proposals.updatedAt
  const before = options.before
  const rows = await listQuery(
    database,
    and(
      tabFilter(userId, tab),
      before
        ? or(lt(sortColumn, before.at), and(eq(sortColumn, before.at), lt(proposals.id, before.id)))
        : undefined,
    ),
  )
    .orderBy(desc(sortColumn), desc(proposals.id))
    .limit(limit + 1)
  const items = await toListItems(database, userId, rows.slice(0, limit))
  return { items, hasMore: rows.length > limit }
}

/** The cursor for the page after `item` on `tab`. */
export function proposalCursorAfter(item: ProposalListItem, tab: ProposalTab): ProposalCursor {
  return { at: tab === "closed" ? (item.closedAt ?? item.updatedAt) : item.updatedAt, id: item.id }
}

/** Open proposals whose offer waits for the user's answer, soonest to expire first (home page). */
export async function listProposalsAwaitingUser(
  database: DbOrTx,
  userId: string,
  limit = 5,
): Promise<ProposalListItem[]> {
  const rows = await listQuery(
    database,
    and(isOpen, isParty(userId), ne(proposalRevisions.authorUserId, userId)),
  )
    .orderBy(asc(proposals.expiresAt), asc(proposals.id))
    .limit(limit)
  return toListItems(database, userId, rows)
}

export type ProposalTabCounts = Record<ProposalTab, number> & { yourTurn: number }

/** How many proposals each tab holds, plus how many wait for the user's answer. */
export async function countProposalTabs(
  database: DbOrTx,
  userId: string,
): Promise<ProposalTabCounts> {
  const open = sql`${proposals.status} IN ('pending', 'countered')`
  const [row] = await database
    .select({
      received: sql<number>`count(*) FILTER (WHERE ${open} AND ${proposals.toUserId} = ${userId})::int`,
      sent: sql<number>`count(*) FILTER (WHERE ${open} AND ${proposals.fromUserId} = ${userId})::int`,
      closed: sql<number>`count(*) FILTER (WHERE NOT (${open}))::int`,
      yourTurn: sql<number>`count(*) FILTER (WHERE ${open} AND ${proposalRevisions.authorUserId} <> ${userId})::int`,
    })
    .from(proposals)
    .leftJoin(proposalRevisions, eq(proposalRevisions.id, proposals.currentRevisionId))
    .where(isParty(userId))
  return {
    received: row?.received ?? 0,
    sent: row?.sent ?? 0,
    closed: row?.closed ?? 0,
    yourTurn: row?.yourTurn ?? 0,
  }
}

/**
 * The user's own targets a proposal to `recipient` could be about, for `/app/proposals/new?to=…`
 * without a target: their open ideas (creators, to a builder) and seeking products (builders, to a
 * creator). Newest first.
 */
export async function listOwnSendableTargets(
  database: DbOrTx,
  userId: string,
  options: { ideas: boolean; products: boolean },
): Promise<{ kind: TargetKind; id: string; title: string }[]> {
  const [ideaRows, productRows] = [
    options.ideas
      ? await database
          .select({ id: ideas.id, title: ideas.title })
          .from(ideas)
          .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
          .where(and(eq(creatorProfiles.userId, userId), eq(ideas.status, "open")))
          .orderBy(desc(ideas.publishedAt))
          .limit(50)
      : [],
    options.products
      ? await database
          .select({ id: products.id, title: products.title })
          .from(products)
          .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
          .where(and(eq(builderProfiles.userId, userId), eq(products.status, "seeking")))
          .orderBy(desc(products.publishedAt))
          .limit(50)
      : [],
  ]
  return [
    ...ideaRows.map((row) => ({ kind: "idea" as const, ...row })),
    ...productRows.map((row) => ({ kind: "product" as const, ...row })),
  ]
}

/** The open proposal between two people about one target, if any (one at a time, §19.24). */
export async function findOpenProposalBetween(
  database: DbOrTx,
  input: { userA: string; userB: string; target: TargetRef },
): Promise<string | null> {
  const [row] = await database
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        isOpen,
        or(
          and(eq(proposals.fromUserId, input.userA), eq(proposals.toUserId, input.userB)),
          and(eq(proposals.fromUserId, input.userB), eq(proposals.toUserId, input.userA)),
        ),
        input.target.kind === "idea"
          ? eq(proposals.ideaId, input.target.id)
          : eq(proposals.productId, input.target.id),
      ),
    )
    .limit(1)
  return row?.id ?? null
}
