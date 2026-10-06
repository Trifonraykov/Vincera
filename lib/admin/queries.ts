import "server-only"

import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm"

import { now } from "@/lib/clock"
import { loadCollabSummary } from "@/lib/collabs/queries"
import type { DbOrTx } from "@/lib/db/client"
import {
  adminAuditLog,
  agreementSignatures,
  agreements,
  collabMembers,
  collabs,
  disputes,
  ideas,
  launches,
  orders,
  products,
  refundRequests,
  socialConnections,
  users,
} from "@/lib/db/schema"
import type {
  AgreementStatus,
  CollabStage,
  DisputeKind,
  DisputeStatus,
  LaunchStatus,
} from "@/lib/db/schema/enums"

import { recentFailedTransferCount } from "./payouts"

/**
 * Read models of the admin pages (Phase 6; CLAUDE.md §19.39): the overview counts, the collabs
 * list and detail, and the audit log. Users, disputes and payouts have their own modules.
 */

// --- Overview ---------------------------------------------------------------------------------

export type AdminOverview = {
  users: { creators: number; builders: number; admins: number; suspended: number; total: number }
  collabsByStage: Record<Exclude<CollabStage, "ended">, number>
  liveLaunches: number
  gmv30d: { currency: string; grossCents: number; orders: number }[]
  pendingReviews: { launches: number; manualConnections: number }
  openDisputes: number
  payoutFailures30d: number
  pendingRefundRequests: number
}

export async function loadAdminOverview(db: DbOrTx, at: Date = now()): Promise<AdminOverview> {
  const since = new Date(at.getTime() - 30 * 24 * 60 * 60 * 1000)
  const [userRows, stageRows, liveRows, gmvRows, reviewRows, manualRows, disputeRows, failed, rr] =
    await Promise.all([
      db
        .select({
          creators: sql<number>`count(*) filter (where 'creator' = any(${users.roles}) and ${users.deletedAt} is null)::int`,
          builders: sql<number>`count(*) filter (where 'builder' = any(${users.roles}) and ${users.deletedAt} is null)::int`,
          admins: sql<number>`count(*) filter (where 'admin' = any(${users.roles}))::int`,
          suspended: sql<number>`count(*) filter (where ${users.status} = 'suspended' and ${users.deletedAt} is null)::int`,
          total: sql<number>`count(*) filter (where ${users.deletedAt} is null)::int`,
        })
        .from(users),
      db
        .select({ stage: collabs.stage, n: sql<number>`count(*)::int` })
        .from(collabs)
        .where(ne(collabs.stage, "ended"))
        .groupBy(collabs.stage),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(launches)
        .where(eq(launches.status, "live")),
      db
        .select({
          currency: orders.currency,
          grossCents: sql<number>`coalesce(sum(${orders.amountGrossCents}), 0)::int`,
          orders: sql<number>`count(*)::int`,
        })
        .from(orders)
        .where(gte(orders.paidAt, since))
        .groupBy(orders.currency),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(launches)
        .where(eq(launches.status, "admin_review")),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(socialConnections)
        .where(
          and(
            eq(socialConnections.source, "manual"),
            isNull(socialConnections.verifiedAt),
            ne(socialConnections.status, "revoked"),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(disputes)
        .where(ne(disputes.status, "resolved")),
      recentFailedTransferCount(db, at),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(refundRequests)
        .where(eq(refundRequests.status, "pending")),
    ])
  const collabsByStage = { agreement: 0, building: 0, launch_review: 0, live: 0 }
  for (const row of stageRows) {
    if (row.stage !== "ended") collabsByStage[row.stage] = row.n
  }
  const u = userRows[0]
  return {
    users: {
      creators: u?.creators ?? 0,
      builders: u?.builders ?? 0,
      admins: u?.admins ?? 0,
      suspended: u?.suspended ?? 0,
      total: u?.total ?? 0,
    },
    collabsByStage,
    liveLaunches: liveRows[0]?.n ?? 0,
    gmv30d: gmvRows,
    pendingReviews: {
      launches: reviewRows[0]?.n ?? 0,
      manualConnections: manualRows[0]?.n ?? 0,
    },
    openDisputes: disputeRows[0]?.n ?? 0,
    payoutFailures30d: failed,
    pendingRefundRequests: rr[0]?.n ?? 0,
  }
}

// --- Collabs ----------------------------------------------------------------------------------

export type AdminCollabListItem = {
  id: string
  title: string
  stage: CollabStage
  lastActivityAt: Date
  createdAt: Date
  members: { userId: string; role: string; name: string }[]
  openDisputes: number
}

/** Collabs, most recently active first, optionally by stage and title. */
export async function listCollabsForAdmin(
  db: DbOrTx,
  filter: { stage?: CollabStage; q?: string } = {},
): Promise<AdminCollabListItem[]> {
  const conditions: (SQL | undefined)[] = []
  if (filter.stage) conditions.push(eq(collabs.stage, filter.stage))
  const q = filter.q?.trim().slice(0, 100)
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    conditions.push(
      or(sql`${ideas.title} ILIKE ${pattern}`, sql`${products.title} ILIKE ${pattern}`),
    )
  }
  const rows = await db
    .select({
      id: collabs.id,
      stage: collabs.stage,
      lastActivityAt: collabs.lastActivityAt,
      createdAt: collabs.createdAt,
      ideaTitle: ideas.title,
      productTitle: products.title,
      openDisputes: sql<number>`(
        SELECT count(*)::int FROM ${disputes} d
        WHERE d.collab_id = "collabs"."id" AND d.status <> 'resolved'
      )`,
    })
    .from(collabs)
    .leftJoin(ideas, eq(ideas.id, collabs.ideaId))
    .leftJoin(products, eq(products.id, collabs.productId))
    .where(and(...conditions))
    .orderBy(desc(collabs.lastActivityAt), desc(collabs.id))
    .limit(100)
  if (rows.length === 0) return []
  const memberRows = await db
    .select({
      collabId: collabMembers.collabId,
      userId: collabMembers.userId,
      role: collabMembers.role,
      name: users.name,
    })
    .from(collabMembers)
    .innerJoin(users, eq(users.id, collabMembers.userId))
    .where(
      inArray(
        collabMembers.collabId,
        rows.map((row) => row.id),
      ),
    )
  return rows.map((row) => ({
    id: row.id,
    title: row.ideaTitle ?? row.productTitle ?? "Untitled",
    stage: row.stage,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    openDisputes: row.openDisputes,
    members: memberRows
      .filter((member) => member.collabId === row.id)
      .sort((a, b) => (a.role === "creator" ? -1 : b.role === "creator" ? 1 : 0))
      .map((member) => ({
        userId: member.userId,
        role: member.role,
        name: member.name ?? "Deleted user",
      })),
  }))
}

export type AdminCollabDetail = {
  summary: NonNullable<Awaited<ReturnType<typeof loadCollabSummary>>>
  agreement: {
    id: string
    status: AgreementStatus
    templateVersion: string
    createdAt: Date
    completedAt: Date | null
    signatures: { userId: string; signedAt: Date }[]
  } | null
  launch: {
    id: string
    title: string
    slug: string
    status: LaunchStatus
    priceCents: number | null
    currency: string
    wentLiveAt: Date | null
    orders: number
    grossCents: number
  } | null
  disputes: {
    id: string
    kind: DisputeKind
    status: DisputeStatus
    createdAt: Date
    raisedByUserId: string
  }[]
}

export async function loadCollabForAdmin(
  db: DbOrTx,
  collabId: string,
): Promise<AdminCollabDetail | null> {
  const summary = await loadCollabSummary(db, collabId)
  if (!summary) return null
  const [agreementRows, launchRows, disputeRows] = await Promise.all([
    db
      .select()
      .from(agreements)
      .where(eq(agreements.collabId, collabId))
      .orderBy(desc(agreements.createdAt))
      .limit(1),
    db.select().from(launches).where(eq(launches.collabId, collabId)),
    db
      .select({
        id: disputes.id,
        kind: disputes.kind,
        status: disputes.status,
        createdAt: disputes.createdAt,
        raisedByUserId: disputes.raisedByUserId,
      })
      .from(disputes)
      .where(eq(disputes.collabId, collabId))
      .orderBy(desc(disputes.createdAt)),
  ])
  const agreement = agreementRows[0]
  const signatures = agreement
    ? await db
        .select({ userId: agreementSignatures.userId, signedAt: agreementSignatures.signedAt })
        .from(agreementSignatures)
        .where(eq(agreementSignatures.agreementId, agreement.id))
    : []
  const launch = launchRows[0]
  const [sales] = launch
    ? await db
        .select({
          n: sql<number>`count(*)::int`,
          gross: sql<number>`coalesce(sum(${orders.amountGrossCents} - ${orders.amountRefundedCents}), 0)::int`,
        })
        .from(orders)
        .where(eq(orders.launchId, launch.id))
    : [undefined]
  return {
    summary,
    agreement: agreement
      ? {
          id: agreement.id,
          status: agreement.status,
          templateVersion: agreement.templateVersion,
          createdAt: agreement.createdAt,
          completedAt: agreement.completedAt,
          signatures,
        }
      : null,
    launch: launch
      ? {
          id: launch.id,
          title: launch.title,
          slug: launch.slug,
          status: launch.status,
          priceCents: launch.priceCents,
          currency: launch.currency,
          wentLiveAt: launch.wentLiveAt,
          orders: sales?.n ?? 0,
          grossCents: sales?.gross ?? 0,
        }
      : null,
    disputes: disputeRows,
  }
}

// --- Audit log --------------------------------------------------------------------------------

export const AUDIT_PAGE_SIZE = 50

export type AuditLogItem = {
  id: string
  createdAt: Date
  adminUserId: string
  adminName: string
  action: string
  targetType: string
  targetId: string | null
  before: unknown
  after: unknown
}

/** Newest first, 50 per page (`before` = the last row's time and id). */
export async function listAuditLog(
  db: DbOrTx,
  filter: {
    adminUserId?: string
    action?: string
    targetType?: string
    targetId?: string
    before?: { createdAt: Date; id: string }
  } = {},
): Promise<{ items: AuditLogItem[]; hasMore: boolean }> {
  const conditions: (SQL | undefined)[] = [
    filter.adminUserId ? eq(adminAuditLog.adminUserId, filter.adminUserId) : undefined,
    filter.action ? eq(adminAuditLog.action, filter.action) : undefined,
    filter.targetType ? eq(adminAuditLog.targetType, filter.targetType) : undefined,
    filter.targetId ? eq(adminAuditLog.targetId, filter.targetId) : undefined,
    filter.before
      ? or(
          lt(adminAuditLog.createdAt, filter.before.createdAt),
          and(
            eq(adminAuditLog.createdAt, filter.before.createdAt),
            lt(adminAuditLog.id, filter.before.id),
          ),
        )
      : undefined,
  ]
  const rows = await db
    .select({
      id: adminAuditLog.id,
      createdAt: adminAuditLog.createdAt,
      adminUserId: adminAuditLog.adminUserId,
      adminName: users.name,
      adminEmail: users.email,
      action: adminAuditLog.action,
      targetType: adminAuditLog.targetType,
      targetId: adminAuditLog.targetId,
      before: adminAuditLog.before,
      after: adminAuditLog.after,
    })
    .from(adminAuditLog)
    .innerJoin(users, eq(users.id, adminAuditLog.adminUserId))
    .where(and(...conditions))
    .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
    .limit(AUDIT_PAGE_SIZE + 1)
  return {
    items: rows.slice(0, AUDIT_PAGE_SIZE).map(({ adminEmail, adminName, ...row }) => ({
      ...row,
      adminName: adminName ?? adminEmail ?? "Deleted user",
    })),
    hasMore: rows.length > AUDIT_PAGE_SIZE,
  }
}

/** Admins who appear in the audit log (the filter's options). */
export async function auditAdmins(db: DbOrTx): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .selectDistinct({ id: users.id, name: users.name, email: users.email })
    .from(adminAuditLog)
    .innerJoin(users, eq(users.id, adminAuditLog.adminUserId))
    .limit(100)
  return rows.map((row) => ({ id: row.id, name: row.name ?? row.email ?? row.id }))
}

/** A keyset cursor `<iso>_<uuid>` → `{ createdAt, id }`, or undefined when malformed. */
export function parseCursor(raw: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!raw) return undefined
  const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)_([0-9a-f-]{36})$/.exec(raw)
  if (!match?.[1] || !match[2]) return undefined
  const createdAt = new Date(match[1])
  return Number.isNaN(createdAt.getTime()) ? undefined : { createdAt, id: match[2] }
}

export function cursorOf(item: { createdAt: Date; id: string }): string {
  return `${item.createdAt.toISOString()}_${item.id}`
}
