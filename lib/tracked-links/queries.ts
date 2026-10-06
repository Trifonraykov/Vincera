import "server-only"

import { eq } from "drizzle-orm"

import type { DayRange } from "@/lib/analytics/range"
import { emptyCounts, launchLinkCounts, type FunnelCounts } from "@/lib/analytics/funnel"
import type { DbOrTx } from "@/lib/db/client"
import { launches } from "@/lib/db/schema"
import type { LaunchStatus } from "@/lib/db/schema/enums"
import { loadLaunchMembers } from "@/lib/launches/queries"

import { listLaunchLinks, type TrackedLinkItem } from "./service"

/**
 * Tracked links with their funnel numbers and owners' names (the links page and the analytics
 * page's "By link" table). `range` null = all time. The unattributed row has `link: null`.
 */

export type LinkWithCounts = {
  link: (TrackedLinkItem & { ownerName: string; ownerRole: "creator" | "builder" | null }) | null
  counts: FunnelCounts
}

export async function loadLinksWithCounts(
  database: DbOrTx,
  input: { launchId: string; collabId: string; range: DayRange | null },
): Promise<{ rows: LinkWithCounts[]; totals: FunnelCounts }> {
  const [links, counts, members] = await Promise.all([
    listLaunchLinks(database, input.launchId),
    launchLinkCounts(database, input.launchId, input.range),
    loadLaunchMembers(database, input.collabId),
  ])
  const byId = new Map(counts.byLink.map((row) => [row.linkId, row]))
  const rows: LinkWithCounts[] = links.map((link) => {
    const member = members.find((m) => m.userId === link.ownerUserId)
    const row = byId.get(link.id)
    return {
      link: {
        ...link,
        ownerName: member?.name ?? "A former member",
        ownerRole: member?.role ?? null,
      },
      counts: row ? stripKey(row) : emptyCounts(),
    }
  })
  const unattributed = byId.get(null)
  if (unattributed) rows.push({ link: null, counts: stripKey(unattributed) })
  return { rows, totals: counts.totals }
}

function stripKey(row: FunnelCounts & { linkId: string | null }): FunnelCounts {
  const { linkId: _linkId, ...counts } = row
  return counts
}

export type LinksLaunch = {
  id: string
  collabId: string
  title: string
  slug: string
  currency: string
  status: LaunchStatus
  wentLiveAt: Date | null
}

export async function loadLinksLaunch(
  database: DbOrTx,
  launchId: string,
): Promise<LinksLaunch | null> {
  const [row] = await database
    .select({
      id: launches.id,
      collabId: launches.collabId,
      title: launches.title,
      slug: launches.slug,
      currency: launches.currency,
      status: launches.status,
      wentLiveAt: launches.wentLiveAt,
    })
    .from(launches)
    .where(eq(launches.id, launchId))
  return row ?? null
}
