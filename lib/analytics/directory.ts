import "server-only"

import { and, desc, eq, inArray } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import {
  builderProfiles,
  collabMembers,
  collabs,
  creatorProfiles,
  ideas,
  launches,
  products,
  users,
} from "@/lib/db/schema"
import type { ProductFormat } from "@/lib/db/schema/enums"
import { launchMediaPath, parseMedia } from "@/lib/launches/fields"

/**
 * The public `/launches` directory (v1; CLAUDE.md §19.38): **live** launches only, newest first
 * (`went_live_at`, the partial index `launches_live_directory_idx`), with what a card shows. The
 * format and topics come from the collab's idea or product; names and handles from the members'
 * profiles for their role, only while the person is active (like `/p/[slug]`). Nothing private:
 * no ids of people, no emails, no numbers.
 */

export const DIRECTORY_LIMIT = 300

export type DirectoryLaunch = {
  slug: string
  title: string
  tagline: string | null
  priceCents: number
  currency: string
  format: ProductFormat | null
  topics: string[]
  /** `/api/launches/<id>/media/<name>` for the first image, or null. */
  imageUrl: string | null
  imageAlt: string | null
  creator: { name: string; handle: string } | null
  builder: { name: string; handle: string } | null
  wentLiveAt: string
}

export async function listDirectoryLaunches(
  database: DbOrTx,
  limit = DIRECTORY_LIMIT,
): Promise<DirectoryLaunch[]> {
  const rows = await database
    .select({
      id: launches.id,
      collabId: launches.collabId,
      slug: launches.slug,
      title: launches.title,
      tagline: launches.tagline,
      priceCents: launches.priceCents,
      currency: launches.currency,
      media: launches.media,
      wentLiveAt: launches.wentLiveAt,
      ideaFormat: ideas.format,
      ideaTopics: ideas.topics,
      productFormat: products.format,
      productTopics: products.topics,
    })
    .from(launches)
    .innerJoin(collabs, eq(collabs.id, launches.collabId))
    .leftJoin(ideas, eq(ideas.id, collabs.ideaId))
    .leftJoin(products, eq(products.id, collabs.productId))
    .where(eq(launches.status, "live"))
    .orderBy(desc(launches.wentLiveAt), desc(launches.id))
    .limit(limit)
  if (rows.length === 0) return []

  const collabIds = rows.map((row) => row.collabId)
  const members = await database
    .select({
      collabId: collabMembers.collabId,
      userId: collabMembers.userId,
      role: collabMembers.role,
    })
    .from(collabMembers)
    .innerJoin(users, eq(users.id, collabMembers.userId))
    .where(and(inArray(collabMembers.collabId, collabIds), eq(users.status, "active")))
  const userIds = [...new Set(members.map((member) => member.userId))]
  const [creators, builders] =
    userIds.length === 0
      ? [[], []]
      : await Promise.all([
          database
            .select({
              userId: creatorProfiles.userId,
              name: creatorProfiles.displayName,
              handle: creatorProfiles.handle,
            })
            .from(creatorProfiles)
            .where(inArray(creatorProfiles.userId, userIds)),
          database
            .select({
              userId: builderProfiles.userId,
              name: builderProfiles.displayName,
              handle: builderProfiles.handle,
            })
            .from(builderProfiles)
            .where(inArray(builderProfiles.userId, userIds)),
        ])
  const creatorBy = new Map(creators.map((p) => [p.userId, { name: p.name, handle: p.handle }]))
  const builderBy = new Map(builders.map((p) => [p.userId, { name: p.name, handle: p.handle }]))
  const person = (collabId: string, role: "creator" | "builder") => {
    const member = members.find((m) => m.collabId === collabId && m.role === role)
    if (!member) return null
    return (role === "creator" ? creatorBy : builderBy).get(member.userId) ?? null
  }

  return rows.flatMap((row) => {
    if (row.priceCents === null || row.wentLiveAt === null) return []
    const image = parseMedia(row.media).find((item) => item.kind === "image")
    return [
      {
        slug: row.slug,
        title: row.title,
        tagline: row.tagline,
        priceCents: row.priceCents,
        currency: row.currency,
        format: row.ideaFormat ?? row.productFormat ?? null,
        topics: [...new Set(row.ideaTopics ?? row.productTopics ?? [])],
        imageUrl: image ? launchMediaPath(row.id, image.url) : null,
        imageAlt: image ? image.alt || row.title : null,
        creator: person(row.collabId, "creator"),
        builder: person(row.collabId, "builder"),
        wentLiveAt: row.wentLiveAt.toISOString(),
      },
    ]
  })
}
