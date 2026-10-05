import { randomBytes } from "node:crypto"

import type { DbOrTx } from "@/lib/db/client"
import {
  builderProfiles,
  collabMembers,
  collabs,
  creatorProfiles,
  handles,
  ideas,
  launches,
  orders,
  products,
  proposalRevisions,
  proposals,
  users,
  type UserRole,
} from "@/lib/db/schema"

/**
 * Minimal row builders for integration tests. Each returns the inserted row; values are unique per
 * call so tests in one file never collide.
 */

function suffix(): string {
  return randomBytes(4).toString("hex")
}

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

export async function insertIdea(db: DbOrTx, creatorProfileId: string) {
  const [idea] = await db
    .insert(ideas)
    .values({ creatorProfileId, title: "Budget tracker for students", format: "app" })
    .returning()
  if (!idea) throw new Error("insertIdea: no row returned")
  return idea
}

export async function insertProduct(db: DbOrTx, builderProfileId: string) {
  const [product] = await db
    .insert(products)
    .values({ builderProfileId, title: "Invoice generator", format: "tool" })
    .returning()
  if (!product) throw new Error("insertProduct: no row returned")
  return product
}

/**
 * A creator, a builder, an idea, an accepted proposal (60/40), a collab with both members and a
 * live launch: everything an order or ledger entry hangs off.
 */
export async function insertLiveLaunch(db: DbOrTx) {
  const creator = await insertCreator(db)
  const builder = await insertBuilder(db)
  const idea = await insertIdea(db, creator.profile.id)

  const [proposal] = await db
    .insert(proposals)
    .values({
      fromUserId: builder.user.id,
      toUserId: creator.user.id,
      ideaId: idea.id,
      status: "accepted",
    })
    .returning()
  if (!proposal) throw new Error("insertLiveLaunch: no proposal")
  await db.insert(proposalRevisions).values({
    proposalId: proposal.id,
    authorUserId: builder.user.id,
    scope: "MVP",
    creatorSplitPct: 60,
    builderSplitPct: 40,
    timelineWeeks: 4,
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
    })
    .returning()
  if (!launch) throw new Error("insertLiveLaunch: no launch")

  return { creator, builder, idea, proposal, collab, launch }
}

export async function insertOrder(db: DbOrTx, launchId: string, paidAt: Date) {
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
    })
    .returning()
  if (!order) throw new Error("insertOrder: no row returned")
  return order
}
