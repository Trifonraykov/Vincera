import "server-only"

import { and, eq, inArray, ne } from "drizzle-orm"

import type { ClaudeDeps } from "@/lib/ai/claude"
import {
  generateLaunchKit,
  LAUNCH_KIT_PLATFORMS,
  type LaunchKitOutput,
  type LaunchKitPlatform,
} from "@/lib/ai/prompts/launch-kit"
import type { DbOrTx } from "@/lib/db/client"
import {
  collabMembers,
  creatorProfiles,
  launches,
  socialConnections,
  trackedLinks,
  type LaunchStatus,
} from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { formatMoney } from "@/lib/money"
import { absoluteUrl } from "@/lib/urls"

import { trackedLinkPath } from "./tracked-links"

/**
 * The launch kit (§7.3 use 4, §12 `/app/launches/[id]/kit`): the creator's tracked link and AI
 * post drafts per platform. Kits are not stored (no column for them; decided here): each
 * generation is shown once and the members copy what they use. `ai.generated` records every
 * generation (subject: the launch).
 */

export type KitContext = {
  launchId: string
  collabId: string
  title: string
  tagline: string | null
  descriptionMd: string | null
  priceCents: number | null
  currency: string
  status: LaunchStatus
  slug: string
  wentLiveAt: Date | null
  deliveryType: (typeof launches.$inferSelect)["deliveryType"]
  creatorUserId: string | null
  link: { code: string; url: string } | null
  platforms: LaunchKitPlatform[]
  creator: { niche: string | null; topics: string[]; audienceSummary: string | null } | null
}

export async function loadKitContext(
  database: DbOrTx,
  launchId: string,
): Promise<KitContext | null> {
  const [launch] = await database.select().from(launches).where(eq(launches.id, launchId))
  if (!launch) return null
  const [creatorMember] = await database
    .select({ userId: collabMembers.userId })
    .from(collabMembers)
    .where(and(eq(collabMembers.collabId, launch.collabId), eq(collabMembers.role, "creator")))
  const creatorUserId = creatorMember?.userId ?? null
  const [link] = await database
    .select({ code: trackedLinks.code })
    .from(trackedLinks)
    .where(and(eq(trackedLinks.launchId, launch.id), eq(trackedLinks.isDefault, true)))
  let creator: KitContext["creator"] = null
  let platforms: LaunchKitPlatform[] = [...LAUNCH_KIT_PLATFORMS]
  if (creatorUserId) {
    const [profile] = await database
      .select({
        niche: creatorProfiles.niche,
        topics: creatorProfiles.topics,
        audienceSummary: creatorProfiles.audienceSummary,
      })
      .from(creatorProfiles)
      .where(eq(creatorProfiles.userId, creatorUserId))
    creator = profile ?? null
    const connected = await database
      .select({ provider: socialConnections.provider })
      .from(socialConnections)
      .where(
        and(
          eq(socialConnections.userId, creatorUserId),
          inArray(socialConnections.provider, [...LAUNCH_KIT_PLATFORMS]),
          ne(socialConnections.status, "revoked"),
        ),
      )
    const providers = new Set(connected.map((row) => row.provider))
    const theirs = LAUNCH_KIT_PLATFORMS.filter((platform) => providers.has(platform))
    // Without a connected platform, write for all three.
    if (theirs.length > 0) platforms = theirs
  }
  return {
    launchId: launch.id,
    collabId: launch.collabId,
    title: launch.title,
    tagline: launch.tagline,
    descriptionMd: launch.descriptionMd,
    priceCents: launch.priceCents,
    currency: launch.currency,
    status: launch.status,
    slug: launch.slug,
    wentLiveAt: launch.wentLiveAt,
    deliveryType: launch.deliveryType,
    creatorUserId,
    link: link ? { code: link.code, url: absoluteUrl(trackedLinkPath(link.code)) } : null,
    platforms,
    creator,
  }
}

export type KitResult =
  | { ok: true; kit: LaunchKitOutput; promptVersion: string }
  | { ok: false; reason: "not_ready" | "fallback" }

/** Draft the posts (never throws for model failures: `fallback`). */
export async function generateKitFor(
  database: DbOrTx,
  input: { userId: string; context: KitContext },
  deps: ClaudeDeps = {},
): Promise<KitResult> {
  const { context } = input
  if (!context.link || context.priceCents === null || context.deliveryType === null) {
    return { ok: false, reason: "not_ready" }
  }
  const result = await generateLaunchKit(
    {
      title: context.title,
      tagline: context.tagline,
      description: context.descriptionMd,
      priceLabel: formatMoney(context.priceCents, context.currency),
      deliveryType: context.deliveryType,
      niche: context.creator?.niche ?? null,
      topics: context.creator?.topics ?? [],
      audienceSummary: context.creator?.audienceSummary ?? null,
      platforms: context.platforms,
      link: context.link.url,
    },
    deps,
  )
  await track(
    "ai.generated",
    {
      actorUserId: input.userId,
      subjectType: "launch",
      subjectId: context.launchId,
      properties: {
        use: "launch_kit",
        prompt_version: result.promptVersion,
        model: result.model,
        latency_ms: result.latencyMs,
        accepted_by_user: null,
        fallback: !result.ok,
      },
    },
    database,
  )
  if (!result.ok) return { ok: false, reason: "fallback" }
  return { ok: true, kit: result.data, promptVersion: result.promptVersion }
}
