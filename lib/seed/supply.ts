import "server-only"

import { and, eq } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { builderProfiles, creatorProfiles, ideas, products } from "@/lib/db/schema"
import { refreshEmbedding } from "@/lib/embeddings/refresh"
import { ideaFieldsSchema } from "@/lib/ideas/fields"
import { createIdea, transitionIdea } from "@/lib/ideas/save"
import { productFieldsSchema } from "@/lib/products/fields"
import { createProduct } from "@/lib/products/save"

import {
  SEED_BUILDERS,
  SEED_CREATORS,
  SEED_IDEAS,
  SEED_PRODUCTS,
  seedBuilderEmail,
  seedCreatorEmail,
} from "./data"
import { findUserIdByEmail } from "./people"
import type { SeedStep } from "./types"

/**
 * Seed step "supply" (owner: matching): the seeded creators' ideas and builders' products in
 * several statuses (open/seeking, draft, archived), created with the app's own functions and
 * form schemas, then embedded. An idea or product whose owner already has one with that title is
 * skipped; one whose owner is missing (the people step failed) too.
 */

async function ideaExists(database: DbOrTx, userId: string, title: string): Promise<boolean> {
  const [row] = await database
    .select({ id: ideas.id })
    .from(ideas)
    .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
    .where(and(eq(creatorProfiles.userId, userId), eq(ideas.title, title)))
  return row !== undefined
}

async function productExists(database: DbOrTx, userId: string, title: string): Promise<boolean> {
  const [row] = await database
    .select({ id: products.id })
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .where(and(eq(builderProfiles.userId, userId), eq(products.title, title)))
  return row !== undefined
}

export const seedSupply: SeedStep = {
  name: "supply",
  owner: "matching",
  run: async ({ db }) => {
    let created = 0
    for (const idea of SEED_IDEAS) {
      if (!SEED_CREATORS[idea.creator]) continue
      const userId = await findUserIdByEmail(db, seedCreatorEmail(idea.creator))
      if (!userId || (await ideaExists(db, userId, idea.title))) continue
      const fields = ideaFieldsSchema.parse({
        title: idea.title,
        problem: idea.problem,
        audienceEvidence: idea.audienceEvidence,
        format: idea.format,
        targetPrice: idea.price,
        topics: idea.topics.join(", "),
      })
      const { ideaId } = await createIdea(db, {
        userId,
        fields,
        intent: idea.status === "open" ? "publish" : "save",
      })
      if (idea.status === "archived") {
        await transitionIdea(db, { userId, ideaId, action: "archive" })
      }
      await refreshEmbedding(db, { type: "idea", id: ideaId })
      created += 1
    }
    for (const product of SEED_PRODUCTS) {
      if (!SEED_BUILDERS[product.builder]) continue
      const userId = await findUserIdByEmail(db, seedBuilderEmail(product.builder))
      if (!userId || (await productExists(db, userId, product.title))) continue
      const fields = productFieldsSchema.parse({
        title: product.title,
        description: product.description,
        targetUser: product.targetUser,
        stage: product.stage,
        demoUrl: product.demoUrl,
        format: product.format,
        targetPrice: product.price,
        topics: product.topics.join(", "),
        preferredSplitBuilderPct: product.preferredSplitBuilderPct,
        exclusivity: product.exclusivity,
      })
      const { productId } = await createProduct(db, {
        userId,
        fields,
        intent: product.status === "seeking" ? "publish" : "save",
      })
      await refreshEmbedding(db, { type: "product", id: productId })
      created += 1
    }
    return { created }
  },
}
