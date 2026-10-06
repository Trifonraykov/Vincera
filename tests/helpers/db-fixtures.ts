import { randomBytes } from "node:crypto"

import { eq } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import {
  accessGrants,
  builderProfiles,
  collabMembers,
  collabs,
  creatorProfiles,
  disputes,
  handles,
  impersonationSessions,
  ideas,
  launches,
  ledgerEntries,
  matches,
  orders,
  payoutBatches,
  portfolioItems,
  products,
  proposalRevisions,
  refundRequests,
  proposals,
  socialConnections,
  stripeAccounts,
  threadReads,
  threads,
  trackedLinks,
  transfers,
  users,
  type CollabStage,
  type MatchFeatures,
  type ProposalStatus,
  type TargetType,
  type UserRole,
} from "@/lib/db/schema"

/**
 * Minimal row builders for integration tests. Each returns the inserted row; values are unique per
 * call so tests in one file never collide. They insert rows directly (no domain logic, no events).
 *
 * Shared by every area (CLAUDE.md §19.24): Phase 2–3 builders add area-specific fixtures to
 * `tests/integration/<area>/helpers.ts`, not here.
 */

function suffix(): string {
  return randomBytes(4).toString("hex")
}

/** Timestamp for fixture columns that only need to be set (published_at, closed_at, ...). */
const FIXTURE_TIME = new Date("2026-01-01T00:00:00Z")

export async function insertUser(db: DbOrTx, overrides: Partial<typeof users.$inferInsert> = {}) {
  const [user] = await db
    .insert(users)
    .values({ email: `user-${suffix()}@example.test`, name: "Test User", ...overrides })
    .returning()
  if (!user) throw new Error("insertUser: no row returned")
  return user
}

async function insertHandle(db: DbOrTx, userId: string, handle: string) {
  await db.insert(handles).values({ handle, userId })
  return handle
}

export async function insertCreator(db: DbOrTx, handle = `creator_${suffix()}`) {
  const roles: UserRole[] = ["creator"]
  const user = await insertUser(db, { roles, activeRole: "creator" })
  await insertHandle(db, user.id, handle)
  const [profile] = await db
    .insert(creatorProfiles)
    .values({ userId: user.id, handle, displayName: `Creator ${handle}` })
    .returning()
  if (!profile) throw new Error("insertCreator: no row returned")
  return { user, profile }
}

export async function insertBuilder(db: DbOrTx, handle = `builder_${suffix()}`) {
  const roles: UserRole[] = ["builder"]
  const user = await insertUser(db, { roles, activeRole: "builder" })
  await insertHandle(db, user.id, handle)
  const [profile] = await db
    .insert(builderProfiles)
    .values({ userId: user.id, handle, displayName: `Builder ${handle}` })
    .returning()
  if (!profile) throw new Error("insertBuilder: no row returned")
  return { user, profile }
}

/** An idea; a draft unless `overrides` say otherwise (`published_at` is filled for open ones). */
export async function insertIdea(
  db: DbOrTx,
  creatorProfileId: string,
  overrides: Partial<typeof ideas.$inferInsert> = {},
) {
  const status = overrides.status ?? "draft"
  const [idea] = await db
    .insert(ideas)
    .values({
      creatorProfileId,
      title: "Budget tracker for students",
      format: "app",
      publishedAt: ["open", "in_collab", "launched"].includes(status) ? FIXTURE_TIME : null,
      archivedAt: status === "archived" ? FIXTURE_TIME : null,
      ...overrides,
    })
    .returning()
  if (!idea) throw new Error("insertIdea: no row returned")
  return idea
}

/** A product; a draft unless `overrides` say otherwise (`published_at` is filled for seeking ones). */
export async function insertProduct(
  db: DbOrTx,
  builderProfileId: string,
  overrides: Partial<typeof products.$inferInsert> = {},
) {
  const status = overrides.status ?? "draft"
  const [product] = await db
    .insert(products)
    .values({
      builderProfileId,
      title: "Invoice generator",
      format: "tool",
      publishedAt: ["seeking", "in_collab", "launched"].includes(status) ? FIXTURE_TIME : null,
      archivedAt: status === "archived" ? FIXTURE_TIME : null,
      ...overrides,
    })
    .returning()
  if (!product) throw new Error("insertProduct: no row returned")
  return product
}

const CLOSED_STATUSES: readonly ProposalStatus[] = ["accepted", "declined", "expired", "withdrawn"]

export type ProposalFixtureInput = {
  fromUserId: string
  toUserId: string
  ideaId?: string
  productId?: string
  status?: ProposalStatus
  creatorSplitPct?: number
  timelineWeeks?: number
  scope?: string
  /** Also create the proposal's thread with a `thread_reads` row per party (never read). */
  withThread?: boolean
}

/**
 * A proposal with its first revision (by the sender) as the current one, like a sent proposal.
 * Closed statuses get `closed_at`. Returns the proposal (with `currentRevisionId` set), the
 * revision and, with `withThread`, the thread id.
 */
export async function insertProposal(db: DbOrTx, input: ProposalFixtureInput) {
  const status = input.status ?? "pending"
  const [proposal] = await db
    .insert(proposals)
    .values({
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      ideaId: input.ideaId ?? null,
      productId: input.productId ?? null,
      status,
      closedAt: CLOSED_STATUSES.includes(status) ? FIXTURE_TIME : null,
    })
    .returning()
  if (!proposal) throw new Error("insertProposal: no proposal")
  const creatorSplitPct = input.creatorSplitPct ?? 60
  const [revision] = await db
    .insert(proposalRevisions)
    .values({
      proposalId: proposal.id,
      authorUserId: input.fromUserId,
      revisionNumber: 1,
      scope: input.scope ?? "MVP",
      creatorSplitPct,
      builderSplitPct: 100 - creatorSplitPct,
      timelineWeeks: input.timelineWeeks ?? 4,
    })
    .returning()
  if (!revision) throw new Error("insertProposal: no revision")
  const [updated] = await db
    .update(proposals)
    .set({ currentRevisionId: revision.id })
    .where(eq(proposals.id, proposal.id))
    .returning()
  if (!updated) throw new Error("insertProposal: no update")
  let threadId: string | null = null
  if (input.withThread) {
    const [thread] = await db
      .insert(threads)
      .values({ kind: "proposal", proposalId: proposal.id })
      .returning()
    if (!thread) throw new Error("insertProposal: no thread")
    threadId = thread.id
    await db.insert(threadReads).values([
      { threadId, userId: input.fromUserId, lastReadAt: null },
      { threadId, userId: input.toUserId, lastReadAt: null },
    ])
  }
  return { proposal: updated, revision, threadId }
}

/**
 * A creator, a builder, an open idea, an accepted proposal (`creatorSplitPct`/rest, default 60/40)
 * and a collab in `stage` (default `agreement`) with both members and its thread. An `ended`
 * collab gets `ended_at` and `ended_reason = completed`.
 */
export async function insertCollab(
  db: DbOrTx,
  options: { stage?: CollabStage; creatorSplitPct?: number } = {},
) {
  const stage = options.stage ?? "agreement"
  const creatorSplitPct = options.creatorSplitPct ?? 60
  const creator = await insertCreator(db)
  const builder = await insertBuilder(db)
  const idea = await insertIdea(db, creator.profile.id, { status: "in_collab" })
  const { proposal } = await insertProposal(db, {
    fromUserId: builder.user.id,
    toUserId: creator.user.id,
    ideaId: idea.id,
    status: "accepted",
    creatorSplitPct,
  })
  const [collab] = await db
    .insert(collabs)
    .values({
      proposalId: proposal.id,
      ideaId: idea.id,
      stage,
      endedAt: stage === "ended" ? FIXTURE_TIME : null,
      endedReason: stage === "ended" ? "completed" : null,
    })
    .returning()
  if (!collab) throw new Error("insertCollab: no collab")
  await db.insert(collabMembers).values([
    { collabId: collab.id, userId: creator.user.id, role: "creator", splitPct: creatorSplitPct },
    {
      collabId: collab.id,
      userId: builder.user.id,
      role: "builder",
      splitPct: 100 - creatorSplitPct,
    },
  ])
  const [thread] = await db
    .insert(threads)
    .values({ kind: "collab", collabId: collab.id })
    .returning()
  if (!thread) throw new Error("insertCollab: no thread")
  await db.insert(threadReads).values([
    { threadId: thread.id, userId: creator.user.id, lastReadAt: null },
    { threadId: thread.id, userId: builder.user.id, lastReadAt: null },
  ])
  return { creator, builder, idea, proposal, collab, threadId: thread.id }
}

/** Every §8 feature at `value` (0–1). */
export function matchFeatures(value = 0.5): MatchFeatures {
  return {
    semantic: value,
    topic_overlap: value,
    audience_fit: value,
    format_fit: value,
    stage_fit: value,
    price_fit: value,
    reliability: value,
  }
}

/** A `v0` match row for `subjectUserId` (score 0.5, every feature 0.5 unless overridden). */
export async function insertMatch(
  db: DbOrTx,
  input: { subjectUserId: string; targetType: TargetType; targetId: string } & Partial<
    typeof matches.$inferInsert
  >,
) {
  const [match] = await db
    .insert(matches)
    .values({
      score: 0.5,
      features: matchFeatures(),
      modelVersion: "v0",
      computedAt: FIXTURE_TIME,
      ...input,
    })
    .returning()
  if (!match) throw new Error("insertMatch: no row returned")
  return match
}

/**
 * A creator, a builder, an idea, an accepted proposal (60/40), a collab with both members and a
 * live launch: everything an order or ledger entry hangs off.
 */
export async function insertLiveLaunch(db: DbOrTx) {
  const creator = await insertCreator(db)
  const builder = await insertBuilder(db)
  const idea = await insertIdea(db, creator.profile.id, { status: "launched" })

  const { proposal } = await insertProposal(db, {
    fromUserId: builder.user.id,
    toUserId: creator.user.id,
    ideaId: idea.id,
    status: "accepted",
    creatorSplitPct: 60,
  })

  const [collab] = await db
    .insert(collabs)
    .values({ proposalId: proposal.id, ideaId: idea.id, stage: "live" })
    .returning()
  if (!collab) throw new Error("insertLiveLaunch: no collab")
  await db.insert(collabMembers).values([
    { collabId: collab.id, userId: creator.user.id, role: "creator", splitPct: 60 },
    { collabId: collab.id, userId: builder.user.id, role: "builder", splitPct: 40 },
  ])

  const [launch] = await db
    .insert(launches)
    .values({
      collabId: collab.id,
      slug: `launch-${suffix()}`,
      title: "Budget tracker",
      priceCents: 1900,
      deliveryType: "url",
      deliveryConfig: { type: "url", url: "https://example.test/app" },
      status: "live",
      submittedAt: FIXTURE_TIME,
      wentLiveAt: FIXTURE_TIME,
    })
    .returning()
  if (!launch) throw new Error("insertLiveLaunch: no launch")

  return { creator, builder, idea, proposal, collab, launch }
}

export async function insertOrder(
  db: DbOrTx,
  launchId: string,
  paidAt: Date,
  overrides: Partial<typeof orders.$inferInsert> = {},
) {
  const [order] = await db
    .insert(orders)
    .values({
      launchId,
      buyerEmail: `buyer-${suffix()}@example.test`,
      stripeCheckoutSessionId: `cs_test_${suffix()}`,
      amountGrossCents: 1900,
      taxCents: 0,
      stripeFeeCents: 85,
      paidAt,
      ...overrides,
    })
    .returning()
  if (!order) throw new Error("insertOrder: no row returned")
  return order
}

/** A tracked link for a launch (random 8-character code). */
export async function insertTrackedLink(
  db: DbOrTx,
  launchId: string,
  ownerUserId: string,
  overrides: Partial<typeof trackedLinks.$inferInsert> = {},
) {
  const [link] = await db
    .insert(trackedLinks)
    .values({
      launchId,
      ownerUserId,
      code: randomBytes(4).toString("hex").slice(0, 8),
      ...overrides,
    })
    .returning()
  if (!link) throw new Error("insertTrackedLink: no row returned")
  return link
}

/** A payout batch (default: a running daily batch with a unique run key). */
export async function insertPayoutBatch(
  db: DbOrTx,
  overrides: Partial<typeof payoutBatches.$inferInsert> = {},
) {
  const [batch] = await db
    .insert(payoutBatches)
    .values({
      runKey: `test:${suffix()}`,
      cutoffAt: FIXTURE_TIME,
      startedAt: FIXTURE_TIME,
      ...overrides,
    })
    .returning()
  if (!batch) throw new Error("insertPayoutBatch: no row returned")
  return batch
}

/** A transfer row (default: `pending`, in a new batch, to a fake connected account). */
export async function insertTransfer(
  db: DbOrTx,
  userId: string,
  overrides: Partial<typeof transfers.$inferInsert> = {},
) {
  const batchId = overrides.batchId ?? (await insertPayoutBatch(db)).id
  const [transfer] = await db
    .insert(transfers)
    .values({
      batchId,
      userId,
      destinationAccountId: `acct_test_${suffix()}`,
      amountCents: 1000,
      ...overrides,
    })
    .returning()
  if (!transfer) throw new Error("insertTransfer: no row returned")
  return transfer
}

/** One ledger entry (default: a creator share of 1000 cents, available on FIXTURE_TIME). */
export async function insertLedgerEntry(
  db: DbOrTx,
  values: Pick<typeof ledgerEntries.$inferInsert, "account" | "amountCents"> &
    Partial<typeof ledgerEntries.$inferInsert>,
) {
  const [entry] = await db
    .insert(ledgerEntries)
    .values({ availableAt: FIXTURE_TIME, ...values })
    .returning()
  if (!entry) throw new Error("insertLedgerEntry: no row returned")
  return entry
}

/**
 * A social data connection. Defaults: an active, verified OAuth YouTube connection without
 * tokens (tests that sync pass encrypted tokens via `overrides`).
 */
export async function insertSocialConnection(
  db: DbOrTx,
  userId: string,
  overrides: Partial<typeof socialConnections.$inferInsert> = {},
) {
  const source = overrides.source ?? "oauth"
  const [connection] = await db
    .insert(socialConnections)
    .values({
      userId,
      provider: "youtube",
      providerAccountId: source === "oauth" ? `acct-${suffix()}` : null,
      username: `user_${suffix()}`,
      verifiedAt: source === "oauth" ? new Date("2026-01-01T00:00:00Z") : null,
      ...overrides,
    })
    .returning()
  if (!connection) throw new Error("insertSocialConnection: no row returned")
  return connection
}

/** A Stripe Connect account row. Defaults to one that has not finished onboarding. */
export async function insertStripeAccount(
  db: DbOrTx,
  userId: string,
  overrides: Partial<typeof stripeAccounts.$inferInsert> = {},
) {
  const [account] = await db
    .insert(stripeAccounts)
    .values({ userId, stripeAccountId: `acct_test_${suffix()}`, ...overrides })
    .returning()
  if (!account) throw new Error("insertStripeAccount: no row returned")
  return account
}

export async function insertPortfolioItem(
  db: DbOrTx,
  builderProfileId: string,
  overrides: Partial<typeof portfolioItems.$inferInsert> = {},
) {
  const [item] = await db
    .insert(portfolioItems)
    .values({
      builderProfileId,
      title: "Invoice CLI",
      url: "https://example.test/cli",
      ...overrides,
    })
    .returning()
  if (!item) throw new Error("insertPortfolioItem: no row returned")
  return item
}

// --- Phases 6–7 (W4 prep, CLAUDE.md §19.38) ----------------------------------------------------

/** An access grant for an order (a valid 43-character token). */
export async function insertAccessGrant(
  db: DbOrTx,
  orderId: string,
  overrides: Partial<typeof accessGrants.$inferInsert> = {},
) {
  const [grant] = await db
    .insert(accessGrants)
    .values({ orderId, token: randomBytes(32).toString("base64url"), ...overrides })
    .returning()
  if (!grant) throw new Error("insertAccessGrant: no row returned")
  return grant
}

/** A collab dispute (default: `open`, kind `split`). */
export async function insertDispute(
  db: DbOrTx,
  collabId: string,
  raisedByUserId: string,
  overrides: Partial<typeof disputes.$inferInsert> = {},
) {
  const [dispute] = await db
    .insert(disputes)
    .values({
      collabId,
      raisedByUserId,
      kind: "split",
      description: "The split no longer reflects the work.",
      ...overrides,
    })
    .returning()
  if (!dispute) throw new Error("insertDispute: no row returned")
  return dispute
}

/** A buyer's refund request (default: `pending`, reason `not_working`, 1900 cents). */
export async function insertRefundRequest(
  db: DbOrTx,
  input: { orderId: string; accessGrantId: string },
  overrides: Partial<typeof refundRequests.$inferInsert> = {},
) {
  const [request] = await db
    .insert(refundRequests)
    .values({ ...input, reason: "not_working", amountCents: 1900, ...overrides })
    .returning()
  if (!request) throw new Error("insertRefundRequest: no row returned")
  return request
}

/** An open "view as" session lasting an hour from `startedAt`. */
export async function insertImpersonationSession(
  db: DbOrTx,
  input: { adminUserId: string; targetUserId: string; startedAt?: Date },
  overrides: Partial<typeof impersonationSessions.$inferInsert> = {},
) {
  const startedAt = input.startedAt ?? FIXTURE_TIME
  const [session] = await db
    .insert(impersonationSessions)
    .values({
      adminUserId: input.adminUserId,
      targetUserId: input.targetUserId,
      reason: "Support request",
      startedAt,
      expiresAt: new Date(startedAt.getTime() + 60 * 60 * 1000),
      ...overrides,
    })
    .returning()
  if (!session) throw new Error("insertImpersonationSession: no row returned")
  return session
}
