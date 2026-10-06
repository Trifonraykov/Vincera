import "server-only"

import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm"

import type { LaunchAccess } from "@/lib/auth/authz"
import type { DbOrTx } from "@/lib/db/client"
import {
  builderProfiles,
  collabMembers,
  collabs,
  creatorProfiles,
  events,
  ideas,
  launchFiles,
  launches,
  licenseKeys,
  linkClicks,
  orders,
  products,
  trackedLinks,
  users,
  type CollabRole,
  type CollabStage,
  type LaunchApproval,
  type LaunchPausedBy,
  type LaunchStatus,
} from "@/lib/db/schema"
import { loadPartyNames } from "@/lib/proposals/queries"

import { parseDeliveryConfig, parseMedia } from "./fields"
import { PUBLIC_LAUNCH_STATUSES, publicLaunchStatus } from "./status"

/**
 * Reads for the launch pages and services (CLAUDE.md §19.32). Nothing here checks permissions:
 * callers authorize with the launch rules in lib/auth/authz.ts on what these return (§6: launch
 * setup data only for the collab's members and admins; `/p/[slug]` only public fields).
 */

export type LaunchRow = typeof launches.$inferSelect

export type LaunchMember = { userId: string; role: CollabRole; name: string; handle: string | null }

/** What the launch rules need (`LaunchAccess`) plus the approvals and who paused. */
export type LaunchAccessRow = LaunchAccess & {
  launchId: string
  collabId: string
  approvedUserIds: string[]
  pausedBy: LaunchPausedBy | null
}

function approvalsOf(value: unknown): LaunchApproval[] {
  return Array.isArray(value) ? (value as LaunchApproval[]) : []
}

/** Member user ids of the approvals of the current version (admin approvals left out). */
export function memberApprovals(approvals: readonly LaunchApproval[]): string[] {
  return approvals.filter((approval) => approval.role !== "admin").map((a) => a.userId)
}

export async function loadLaunchAccess(
  database: DbOrTx,
  launchId: string,
): Promise<LaunchAccessRow | null> {
  const [row] = await database
    .select({
      launchId: launches.id,
      collabId: launches.collabId,
      status: launches.status,
      approvedBy: launches.approvedBy,
      pausedBy: launches.pausedBy,
      collabStage: collabs.stage,
    })
    .from(launches)
    .innerJoin(collabs, eq(collabs.id, launches.collabId))
    .where(eq(launches.id, launchId))
  if (!row) return null
  const members = await database
    .select({ userId: collabMembers.userId })
    .from(collabMembers)
    .where(eq(collabMembers.collabId, row.collabId))
  return {
    launchId: row.launchId,
    collabId: row.collabId,
    status: row.status,
    collabStage: row.collabStage,
    pausedBy: row.pausedBy,
    approvedUserIds: memberApprovals(approvalsOf(row.approvedBy)),
    memberUserIds: members.map((member) => member.userId),
  }
}

export async function findLaunchIdForCollab(
  database: DbOrTx,
  collabId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ id: launches.id })
    .from(launches)
    .where(eq(launches.collabId, collabId))
  return row?.id ?? null
}

export type LaunchFileItem = {
  id: string
  filename: string
  sizeBytes: number
  contentType: string | null
}

export type LaunchSetup = {
  launch: LaunchRow
  approvals: LaunchApproval[]
  files: LaunchFileItem[]
  keys: { unassigned: number; assigned: number }
  defaultLink: { id: string; code: string } | null
}

/** Everything the setup page shows for a collab's launch, or null before it was created. */
export async function loadLaunchSetup(
  database: DbOrTx,
  collabId: string,
): Promise<LaunchSetup | null> {
  const [launch] = await database.select().from(launches).where(eq(launches.collabId, collabId))
  if (!launch) return null
  const [files, keyRows, links] = await Promise.all([
    database
      .select({
        id: launchFiles.id,
        filename: launchFiles.filename,
        sizeBytes: launchFiles.sizeBytes,
        contentType: launchFiles.contentType,
      })
      .from(launchFiles)
      .where(eq(launchFiles.launchId, launch.id))
      .orderBy(asc(launchFiles.position), asc(launchFiles.createdAt)),
    database
      .select({ assigned: sql<boolean>`${licenseKeys.orderId} IS NOT NULL`, count: count() })
      .from(licenseKeys)
      .where(eq(licenseKeys.launchId, launch.id))
      .groupBy(sql`${licenseKeys.orderId} IS NOT NULL`),
    database
      .select({ id: trackedLinks.id, code: trackedLinks.code })
      .from(trackedLinks)
      .where(and(eq(trackedLinks.launchId, launch.id), eq(trackedLinks.isDefault, true))),
  ])
  const keys = { unassigned: 0, assigned: 0 }
  for (const row of keyRows) keys[row.assigned ? "assigned" : "unassigned"] = row.count
  return {
    launch,
    approvals: approvalsOf(launch.approvedBy),
    files,
    keys,
    defaultLink: links[0] ?? null,
  }
}

/** Counts the completeness check needs (files and unassigned keys). */
export async function loadContentCounts(
  database: DbOrTx,
  launchId: string,
): Promise<{ fileCount: number; unassignedKeyCount: number }> {
  const [[files], [keys]] = await Promise.all([
    database.select({ n: count() }).from(launchFiles).where(eq(launchFiles.launchId, launchId)),
    database
      .select({ n: count() })
      .from(licenseKeys)
      .where(and(eq(licenseKeys.launchId, launchId), isNull(licenseKeys.orderId))),
  ])
  return { fileCount: files?.n ?? 0, unassignedKeyCount: keys?.n ?? 0 }
}

/** The collab's members with their display names (creator first). */
export async function loadLaunchMembers(
  database: DbOrTx,
  collabId: string,
): Promise<LaunchMember[]> {
  const rows = await database
    .select({ userId: collabMembers.userId, role: collabMembers.role })
    .from(collabMembers)
    .where(eq(collabMembers.collabId, collabId))
  const names = await loadPartyNames(database, rows)
  return rows
    .map((row) => ({
      ...row,
      name: names.get(row.userId)?.name ?? (row.role === "creator" ? "A creator" : "A builder"),
      handle: names.get(row.userId)?.handle ?? null,
    }))
    .sort((a, b) => (a.role === b.role ? 0 : a.role === "creator" ? -1 : 1))
}

// --- Lists ----------------------------------------------------------------------------------

export type LaunchStats = { clicks: number; views: number; orders: number; grossCents: number }

export type LaunchListItem = {
  id: string
  collabId: string
  title: string
  slug: string
  status: LaunchStatus
  priceCents: number | null
  currency: string
  wentLiveAt: Date | null
  updatedAt: Date
  stats: LaunchStats
}

async function statsFor(database: DbOrTx, launchIds: string[]): Promise<Map<string, LaunchStats>> {
  const result = new Map<string, LaunchStats>(
    launchIds.map((id) => [id, { clicks: 0, views: 0, orders: 0, grossCents: 0 }]),
  )
  if (launchIds.length === 0) return result
  const [clickRows, orderRows, viewRows] = await Promise.all([
    database
      .select({ launchId: trackedLinks.launchId, n: count() })
      .from(linkClicks)
      .innerJoin(trackedLinks, eq(trackedLinks.id, linkClicks.trackedLinkId))
      .where(and(inArray(trackedLinks.launchId, launchIds), eq(linkClicks.isBot, false)))
      .groupBy(trackedLinks.launchId),
    database
      .select({
        launchId: orders.launchId,
        n: count(),
        gross: sql<number>`coalesce(sum(${orders.amountGrossCents} - ${orders.amountRefundedCents}), 0)::int`,
      })
      .from(orders)
      .where(inArray(orders.launchId, launchIds))
      .groupBy(orders.launchId),
    database
      .select({ launchId: events.subjectId, n: count() })
      .from(events)
      .where(and(eq(events.type, "product_page.viewed"), inArray(events.subjectId, launchIds)))
      .groupBy(events.subjectId),
  ])
  for (const row of viewRows) {
    const stats = row.launchId ? result.get(row.launchId) : undefined
    if (stats) stats.views = row.n
  }
  for (const row of clickRows) {
    const stats = result.get(row.launchId)
    if (stats) stats.clicks = row.n
  }
  for (const row of orderRows) {
    const stats = result.get(row.launchId)
    if (stats) {
      stats.orders = row.n
      stats.grossCents = Number(row.gross)
    }
  }
  return result
}

const listColumns = {
  id: launches.id,
  collabId: launches.collabId,
  title: launches.title,
  slug: launches.slug,
  status: launches.status,
  priceCents: launches.priceCents,
  currency: launches.currency,
  wentLiveAt: launches.wentLiveAt,
  updatedAt: launches.updatedAt,
}

/** The user's launches (collabs they are a member of), live ones first, then newest. */
export async function listLaunchesForUser(
  database: DbOrTx,
  userId: string,
): Promise<LaunchListItem[]> {
  const rows = await database
    .select(listColumns)
    .from(launches)
    .innerJoin(collabMembers, eq(collabMembers.collabId, launches.collabId))
    .where(eq(collabMembers.userId, userId))
    .orderBy(
      sql`CASE ${launches.status} WHEN 'live' THEN 0 WHEN 'paused' THEN 1 WHEN 'ended' THEN 3 ELSE 2 END`,
      desc(launches.updatedAt),
    )
    .limit(200)
  const stats = await statsFor(
    database,
    rows.map((row) => row.id),
  )
  return rows.map((row) => ({
    ...row,
    stats: stats.get(row.id) ?? { clicks: 0, views: 0, orders: 0, grossCents: 0 },
  }))
}

export type AdminLaunchItem = LaunchListItem & {
  tagline: string | null
  descriptionMd: string | null
  deliveryType: LaunchRow["deliveryType"]
  deliveryUrl: string | null
  submittedAt: Date | null
  reviewNote: string | null
  pausedBy: LaunchPausedBy | null
  media: ReturnType<typeof parseMedia>
  fileCount: number
  members: LaunchMember[]
}

/** Launches in one status for the admin pages, oldest submission first for the queue. */
export async function listLaunchesForAdmin(
  database: DbOrTx,
  status: LaunchStatus,
): Promise<AdminLaunchItem[]> {
  const rows = await database
    .select({
      ...listColumns,
      tagline: launches.tagline,
      descriptionMd: launches.descriptionMd,
      deliveryType: launches.deliveryType,
      deliveryConfig: launches.deliveryConfig,
      submittedAt: launches.submittedAt,
      reviewNote: launches.reviewNote,
      pausedBy: launches.pausedBy,
      media: launches.media,
    })
    .from(launches)
    .where(eq(launches.status, status))
    .orderBy(
      status === "admin_review" ? asc(launches.submittedAt) : desc(launches.updatedAt),
      asc(launches.id),
    )
    .limit(100)
  const ids = rows.map((row) => row.id)
  const [stats, fileRows] = await Promise.all([
    statsFor(database, ids),
    ids.length === 0
      ? Promise.resolve([])
      : database
          .select({ launchId: launchFiles.launchId, n: count() })
          .from(launchFiles)
          .where(inArray(launchFiles.launchId, ids))
          .groupBy(launchFiles.launchId),
  ])
  const files = new Map(fileRows.map((row) => [row.launchId, row.n]))
  return Promise.all(
    rows.map(async (row) => {
      const config = parseDeliveryConfig(row.deliveryConfig)
      return {
        id: row.id,
        collabId: row.collabId,
        title: row.title,
        slug: row.slug,
        status: row.status,
        priceCents: row.priceCents,
        currency: row.currency,
        wentLiveAt: row.wentLiveAt,
        updatedAt: row.updatedAt,
        tagline: row.tagline,
        descriptionMd: row.descriptionMd,
        deliveryType: row.deliveryType,
        deliveryUrl: config?.type === "url" ? config.url : null,
        submittedAt: row.submittedAt,
        reviewNote: row.reviewNote,
        pausedBy: row.pausedBy,
        media: parseMedia(row.media),
        fileCount: files.get(row.id) ?? 0,
        members: await loadLaunchMembers(database, row.collabId),
        stats: stats.get(row.id) ?? { clicks: 0, views: 0, orders: 0, grossCents: 0 },
      }
    }),
  )
}

export async function countLaunchesInReview(database: DbOrTx): Promise<number> {
  const [row] = await database
    .select({ n: count() })
    .from(launches)
    .where(eq(launches.status, "admin_review"))
  return row?.n ?? 0
}

/** Active admins, who get `admin.launch_review_requested`. */
export async function adminUserIds(database: DbOrTx): Promise<string[]> {
  const rows = await database
    .select({ id: users.id })
    .from(users)
    .where(and(sql`'admin' = ANY(${users.roles})`, eq(users.status, "active")))
  return rows.map((row) => row.id)
}

// --- The public product page ----------------------------------------------------------------

/** SQL for `isPublicLaunch` (status.ts): a public status, or a launch that went live once. */
const publicLaunchCondition = or(
  inArray(launches.status, [...PUBLIC_LAUNCH_STATUSES]),
  isNotNull(launches.wentLiveAt),
)

export type PublicLaunch = {
  id: string
  slug: string
  title: string
  tagline: string | null
  descriptionMd: string | null
  priceCents: number
  currency: string
  status: (typeof PUBLIC_LAUNCH_STATUSES)[number]
  deliveryType: NonNullable<LaunchRow["deliveryType"]>
  media: ReturnType<typeof parseMedia>
  creator: { name: string; handle: string } | null
  builder: { name: string; handle: string } | null
}

/**
 * The public fields of a live, paused or ended launch (§12 `/p/[slug]`), or null: unknown slugs,
 * launches that never went live, and launches whose members are suspended are 404s. Names and
 * handles come from the members' profiles for their role, and only when that person is active.
 */
export async function loadPublicLaunch(
  database: DbOrTx,
  slug: string,
): Promise<PublicLaunch | null> {
  const [row] = await database
    .select()
    .from(launches)
    .where(and(eq(launches.slug, slug), publicLaunchCondition))
  if (!row || row.priceCents === null || row.deliveryType === null) return null
  const status = publicLaunchStatus(row.status)
  const members = await database
    .select({ userId: collabMembers.userId, role: collabMembers.role, status: users.status })
    .from(collabMembers)
    .innerJoin(users, eq(users.id, collabMembers.userId))
    .where(eq(collabMembers.collabId, row.collabId))
  const person = async (role: CollabRole) => {
    const member = members.find((m) => m.role === role && m.status === "active")
    if (!member) return null
    const table = role === "creator" ? creatorProfiles : builderProfiles
    const [profile] = await database
      .select({ name: table.displayName, handle: table.handle })
      .from(table)
      .where(eq(table.userId, member.userId))
    return profile ?? null
  }
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    tagline: row.tagline,
    descriptionMd: row.descriptionMd,
    priceCents: row.priceCents,
    currency: row.currency,
    status,
    deliveryType: row.deliveryType,
    media: parseMedia(row.media),
    creator: await person("creator"),
    builder: await person("builder"),
  }
}

/** The launch a public slug belongs to, for the view beacon (public statuses only). */
export async function findPublicLaunchId(database: DbOrTx, slug: string): Promise<string | null> {
  const [row] = await database
    .select({ id: launches.id })
    .from(launches)
    .where(and(eq(launches.slug, slug), publicLaunchCondition))
  return row?.id ?? null
}

/** The idea's or product's id and the exclusivity flag, for go-live side effects. */
export async function loadCollabTarget(
  database: DbOrTx,
  collabId: string,
): Promise<{ ideaId: string | null; productId: string | null; exclusive: boolean }> {
  const [row] = await database
    .select({
      ideaId: collabs.ideaId,
      productId: collabs.productId,
      exclusive: products.exclusivity,
      ideaTitle: ideas.title,
    })
    .from(collabs)
    .leftJoin(products, eq(products.id, collabs.productId))
    .leftJoin(ideas, eq(ideas.id, collabs.ideaId))
    .where(eq(collabs.id, collabId))
  return {
    ideaId: row?.ideaId ?? null,
    productId: row?.productId ?? null,
    exclusive: row?.exclusive ?? false,
  }
}

export type { CollabStage }
