import "server-only"

import { and, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"

import type { DbOrTx } from "@/lib/db/client"
import { events, launches, ledgerEntries, linkClicks, orders, trackedLinks } from "@/lib/db/schema"
import type { LaunchStatus } from "@/lib/db/schema/enums"

import { rangeBounds, rangeDays, type DayRange } from "./range"

/**
 * The collab analytics funnel (§10 "clicks → product page views → checkout started → paid
 * orders"; CLAUDE.md §19.38): per launch, over a UTC day range, overall, by tracked link and by
 * day. Each source is counted on its own with one grouped query (no joins that multiply rows):
 *
 * - clicks: `link_clicks` of the launch's links with `is_bot = false` (plus distinct visitors);
 * - views: `product_page.viewed` events whose subject is the launch;
 * - checkouts: `checkout.started` events whose subject is the launch;
 * - orders: orders of the launch with `paid_at` in range, any status (refunds shown apart).
 *
 * Views and checkouts are attributed by `properties->>'tracked_link_id'`, orders by
 * `orders.tracked_link_id`; anything unattributed is the "No link" row (`linkId: null`). Views
 * can exceed clicks (people who come straight to the product page).
 */

export type FunnelCounts = {
  clicks: number
  visitors: number
  views: number
  checkouts: number
  orders: number
  grossCents: number
  refundedCents: number
}

export type FunnelLinkRow = FunnelCounts & {
  /** Null: views, checkouts and orders that came without a tracked link. */
  linkId: string | null
}

export type FunnelDay = Omit<FunnelCounts, "refundedCents"> & { day: string }

export type FunnelLaunch = {
  id: string
  title: string
  slug: string
  status: LaunchStatus
  currency: string
  wentLiveAt: Date | null
}

export type LaunchFunnel = {
  launch: FunnelLaunch
  range: DayRange
  totals: FunnelCounts
  byLink: FunnelLinkRow[]
  daily: FunnelDay[]
  /**
   * The viewer's own share of these orders (their share entries and refund mirrors), integer
   * cents; null when the viewer is not a member (admins). Never the other member's share.
   */
  viewerShareCents: number | null
}

export function emptyCounts(): FunnelCounts {
  return {
    clicks: 0,
    visitors: 0,
    views: 0,
    checkouts: 0,
    orders: 0,
    grossCents: 0,
    refundedCents: 0,
  }
}

type Bounds = { start: Date; end: Date } | null

function within(column: AnyPgColumn, bounds: Bounds): SQL | undefined {
  return bounds ? and(gte(column, bounds.start), lt(column, bounds.end)) : undefined
}

function utcDayOf(column: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
}

const eventLink = sql<string | null>`${events.properties}->>'tracked_link_id'`

/**
 * Counts per key (a tracked link id, or a UTC day) for one launch. `group` decides the key:
 * `link` groups by the tracked link (null = unattributed), `day` by UTC day.
 */
async function countsBy(
  database: DbOrTx,
  launchId: string,
  bounds: Bounds,
  group: "link" | "day",
): Promise<Map<string | null, FunnelCounts>> {
  const clickKey =
    group === "link"
      ? sql<string | null>`${linkClicks.trackedLinkId}::text`
      : utcDayOf(linkClicks.clickedAt)
  const eventKey = group === "link" ? eventLink : utcDayOf(events.occurredAt)
  const orderKey =
    group === "link" ? sql<string | null>`${orders.trackedLinkId}::text` : utcDayOf(orders.paidAt)

  const eventCounts = (type: "product_page.viewed" | "checkout.started") =>
    database
      .select({ key: eventKey, n: sql<number>`count(*)::int` })
      .from(events)
      .where(
        and(
          eq(events.subjectId, launchId),
          eq(events.type, type),
          within(events.occurredAt, bounds),
        ),
      )
      .groupBy(eventKey)

  const [clickRows, viewRows, checkoutRows, orderRows] = await Promise.all([
    database
      .select({
        key: clickKey,
        n: sql<number>`count(*)::int`,
        visitors: sql<number>`count(DISTINCT ${linkClicks.visitorId})::int`,
      })
      .from(linkClicks)
      .innerJoin(trackedLinks, eq(trackedLinks.id, linkClicks.trackedLinkId))
      .where(
        and(
          eq(trackedLinks.launchId, launchId),
          eq(linkClicks.isBot, false),
          within(linkClicks.clickedAt, bounds),
        ),
      )
      .groupBy(clickKey),
    eventCounts("product_page.viewed"),
    eventCounts("checkout.started"),
    database
      .select({
        key: orderKey,
        n: sql<number>`count(*)::int`,
        gross: sql<number>`coalesce(sum(${orders.amountGrossCents}), 0)::int`,
        refunded: sql<number>`coalesce(sum(${orders.amountRefundedCents}), 0)::int`,
      })
      .from(orders)
      .where(and(eq(orders.launchId, launchId), within(orders.paidAt, bounds)))
      .groupBy(orderKey),
  ])

  const result = new Map<string | null, FunnelCounts>()
  const at = (key: string | null) => {
    let counts = result.get(key)
    if (!counts) {
      counts = emptyCounts()
      result.set(key, counts)
    }
    return counts
  }
  for (const row of clickRows) {
    const counts = at(row.key)
    counts.clicks = Number(row.n)
    counts.visitors = Number(row.visitors)
  }
  for (const row of viewRows) at(row.key).views = Number(row.n)
  for (const row of checkoutRows) at(row.key).checkouts = Number(row.n)
  for (const row of orderRows) {
    const counts = at(row.key)
    counts.orders = Number(row.n)
    counts.grossCents = Number(row.gross)
    counts.refundedCents = Number(row.refunded)
  }
  return result
}

function addInto(total: FunnelCounts, part: FunnelCounts): void {
  total.clicks += part.clicks
  total.visitors += part.visitors
  total.views += part.views
  total.checkouts += part.checkouts
  total.orders += part.orders
  total.grossCents += part.grossCents
  total.refundedCents += part.refundedCents
}

/**
 * Funnel counts per tracked link of a launch (every link of the launch gets a row, even with no
 * activity; the "No link" row only when it has something). `range` null = all time. Totals are
 * the sum of the rows, except `visitors`, which is counted across links (a person who clicked two
 * links is one visitor).
 */
export async function launchLinkCounts(
  database: DbOrTx,
  launchId: string,
  range: DayRange | null,
): Promise<{ totals: FunnelCounts; byLink: FunnelLinkRow[] }> {
  const bounds = range ? rangeBounds(range) : null
  const [counts, links, [visitors]] = await Promise.all([
    countsBy(database, launchId, bounds, "link"),
    database
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(eq(trackedLinks.launchId, launchId))
      .orderBy(sql`${trackedLinks.isDefault} DESC`, trackedLinks.createdAt),
    database
      .select({ n: sql<number>`count(DISTINCT ${linkClicks.visitorId})::int` })
      .from(linkClicks)
      .innerJoin(trackedLinks, eq(trackedLinks.id, linkClicks.trackedLinkId))
      .where(
        and(
          eq(trackedLinks.launchId, launchId),
          eq(linkClicks.isBot, false),
          within(linkClicks.clickedAt, bounds),
        ),
      ),
  ])
  const totals = emptyCounts()
  const byLink: FunnelLinkRow[] = []
  const known = new Set<string>()
  for (const link of links) {
    known.add(link.id)
    const row = counts.get(link.id) ?? emptyCounts()
    byLink.push({ linkId: link.id, ...row })
    addInto(totals, row)
  }
  // Events naming a link of another launch (never written by the app) count as unattributed.
  const unattributed = emptyCounts()
  for (const [key, row] of counts) {
    if (key === null || !known.has(key)) addInto(unattributed, row)
  }
  addInto(totals, unattributed)
  if (Object.values(unattributed).some((value) => value !== 0)) {
    byLink.push({ linkId: null, ...unattributed })
  }
  totals.visitors = Number(visitors?.n ?? 0)
  return { totals, byLink }
}

/** Daily funnel counts over a range; every day of the range has a row. */
export async function launchDailyCounts(
  database: DbOrTx,
  launchId: string,
  range: DayRange,
): Promise<FunnelDay[]> {
  const counts = await countsBy(database, launchId, rangeBounds(range), "day")
  return rangeDays(range).map((day) => {
    const row = counts.get(day) ?? emptyCounts()
    return {
      day,
      clicks: row.clicks,
      visitors: row.visitors,
      views: row.views,
      checkouts: row.checkouts,
      orders: row.orders,
      grossCents: row.grossCents,
    }
  })
}

/** The viewer's share entries (and their refund/chargeback mirrors) of the launch's orders. */
export async function viewerShareOfOrders(
  database: DbOrTx,
  input: { launchId: string; userId: string; range: DayRange | null },
): Promise<number> {
  const bounds = input.range ? rangeBounds(input.range) : null
  const [row] = await database
    .select({ cents: sql<number>`coalesce(sum(${ledgerEntries.amountCents}), 0)::int` })
    .from(ledgerEntries)
    .innerJoin(orders, eq(orders.id, ledgerEntries.orderId))
    .where(
      and(
        eq(orders.launchId, input.launchId),
        eq(ledgerEntries.userId, input.userId),
        inArray(ledgerEntries.account, ["creator_share", "builder_share"]),
        isNull(ledgerEntries.adjustmentId),
        within(orders.paidAt, bounds),
      ),
    )
  return Number(row?.cents ?? 0)
}

/** The collab's launch (one per collab), or null before it has one. */
export async function loadFunnelLaunch(
  database: DbOrTx,
  collabId: string,
): Promise<FunnelLaunch | null> {
  const [row] = await database
    .select({
      id: launches.id,
      title: launches.title,
      slug: launches.slug,
      status: launches.status,
      currency: launches.currency,
      wentLiveAt: launches.wentLiveAt,
    })
    .from(launches)
    .where(eq(launches.collabId, collabId))
  return row ?? null
}

/**
 * Everything `/app/collabs/[id]/analytics` shows for one launch. `viewerUserId` null (an admin
 * reading) leaves the share out. The caller authorizes (`canViewCollabAnalytics`).
 */
export async function loadLaunchFunnel(
  database: DbOrTx,
  input: { launch: FunnelLaunch; range: DayRange; viewerUserId: string | null },
): Promise<LaunchFunnel> {
  const [links, daily, share] = await Promise.all([
    launchLinkCounts(database, input.launch.id, input.range),
    launchDailyCounts(database, input.launch.id, input.range),
    input.viewerUserId
      ? viewerShareOfOrders(database, {
          launchId: input.launch.id,
          userId: input.viewerUserId,
          range: input.range,
        })
      : Promise.resolve(null),
  ])
  return {
    launch: input.launch,
    range: input.range,
    totals: links.totals,
    byLink: links.byLink,
    daily,
    viewerShareCents: share,
  }
}
