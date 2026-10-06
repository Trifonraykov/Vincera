import { eq } from "drizzle-orm"

import { builderProfiles } from "@/lib/db/schema"
import { refreshEmbedding } from "@/lib/embeddings/refresh"
import {
  appStoreVerificationCode,
  checkAppStoreVerification,
  connectAppStore,
} from "@/lib/listings/app-store/service"
import { createFakeInternet, publishFakeVerificationCode } from "@/lib/listings/fake/internet"
import { importWebListing } from "@/lib/listings/web/service"

import { seedBuilderEmail } from "./data"
import { findUserIdByEmail } from "./people"
import type { SeedStep } from "./types"

/**
 * Seed step "listings" (CLAUDE.md §19.45): imported listings so the creator feed looks like the
 * real thing. Two builders connect the fake App Store's developers (Pinecone Labs, verified with
 * the description code; Tiny Forge Studio, left unverified) and two import web pages from the fake
 * web (TaskTide and Quiet Notes; a Notion template shop). Everything goes through the real import
 * code with the recorded fixtures (lib/listings/fake), so images are real PNG copies in storage.
 * Runs before "matches", so the creators' lists can rank the listings. Idempotent: App Store
 * builders that are already connected are skipped, and re-importing a web page updates it.
 */

const APP_STORE_BUILDERS = [
  { index: 2, developerId: "1500000001", verify: true },
  { index: 5, developerId: "1500000002", verify: false },
] as const

const WEB_BUILDERS = [
  { index: 6, urls: ["https://go.tasktide.example/", "https://quietnotes.example/"] },
  { index: 7, urls: ["https://shop.templatehouse.example/notion/creator-content-calendar"] },
] as const

async function builderOf(db: Parameters<SeedStep["run"]>[0]["db"], index: number) {
  const userId = await findUserIdByEmail(db, seedBuilderEmail(index))
  if (!userId) return null
  const [profile] = await db
    .select({ id: builderProfiles.id, developerId: builderProfiles.appStoreDeveloperId })
    .from(builderProfiles)
    .where(eq(builderProfiles.userId, userId))
  return profile ? { userId, ...profile } : null
}

export const seedListings: SeedStep = {
  name: "listings",
  owner: "listings",
  run: async ({ db }) => {
    const transport = createFakeInternet()
    let created = 0
    const embed = async (ids: readonly string[]) => {
      for (const id of ids) await refreshEmbedding(db, { type: "product", id })
    }

    for (const entry of APP_STORE_BUILDERS) {
      const builder = await builderOf(db, entry.index)
      if (!builder || builder.developerId) continue
      const summary = await connectAppStore(
        db,
        { userId: builder.userId, raw: entry.developerId },
        { transport },
      )
      created += summary.created
      await embed(summary.listings.map((listing) => listing.productId))
      if (entry.verify) {
        // As a builder would: put the code in an app description, check, then take it out again.
        await publishFakeVerificationCode(
          entry.developerId,
          appStoreVerificationCode(builder.id, entry.developerId),
        )
        await checkAppStoreVerification(db, { userId: builder.userId }, { transport })
        await publishFakeVerificationCode(entry.developerId, "")
      }
    }

    for (const entry of WEB_BUILDERS) {
      const builder = await builderOf(db, entry.index)
      if (!builder) continue
      for (const url of entry.urls) {
        const result = await importWebListing(db, { userId: builder.userId, url }, { transport })
        if (result.action === "created") {
          created += 1
          await embed([result.productId])
        }
      }
    }
    return { created }
  },
}
