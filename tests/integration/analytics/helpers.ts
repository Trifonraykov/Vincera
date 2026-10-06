import type { Db } from "@/lib/db/client"
import { linkClicks } from "@/lib/db/schema"
import { track } from "@/lib/events/track"

/** Shared fixtures of the analytics integration tests (CLAUDE.md §19.41). */

export function at(day: string, time = "12:00:00"): Date {
  return new Date(`${day}T${time}.000Z`)
}

export async function click(
  db: Db,
  trackedLinkId: string,
  clickedAt: Date,
  options: { visitorId?: string; isBot?: boolean } = {},
) {
  await db.insert(linkClicks).values({
    trackedLinkId,
    clickedAt,
    visitorId: options.visitorId ?? null,
    isBot: options.isBot ?? false,
  })
}

export async function view(db: Db, launchId: string, linkId: string | null, occurredAt: Date) {
  await track(
    "product_page.viewed",
    {
      actorUserId: null,
      subjectType: "launch",
      subjectId: launchId,
      properties: { tracked_link_id: linkId },
      occurredAt,
    },
    db,
  )
}

export async function checkoutStarted(
  db: Db,
  launchId: string,
  linkId: string | null,
  occurredAt: Date,
) {
  await track(
    "checkout.started",
    {
      actorUserId: null,
      subjectType: "launch",
      subjectId: launchId,
      properties: { tracked_link_id: linkId, price_cents: 1900, currency: "eur" },
      occurredAt,
    },
    db,
  )
}
