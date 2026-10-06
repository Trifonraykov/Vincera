import "server-only"

import { and, eq, getTableColumns, inArray } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { builderProfiles, products, type ProductStatus } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { SUPPLY_CURRENCY, type SupplyIntent } from "@/lib/supply/fields"
import {
  nextStatus,
  refusalMessage,
  statusesAllowing,
  type SupplyAction,
} from "@/lib/supply/lifecycle"
import { eventTopics, sameList } from "@/lib/supply/save-helpers"

import { PRODUCT_COLUMNS, productPublishProblems, type ProductFields } from "./fields"
import { countActiveCollabs, type ProductRow } from "./queries"

/**
 * Writes for products (§5, §11 `product.*`; lifecycle in lib/supply/lifecycle.ts, CLAUDE.md
 * §19.24 / §19.25). Like lib/ideas/save.ts: one transaction per change with its events, ownership
 * re-checked under the row lock, embedding refresh and revalidation left to the caller.
 *
 * Exclusivity (§19.24): an exclusive product goes to `in_collab` when a proposal is accepted; a
 * non-exclusive one stays `seeking` and may have several collabs. So a product that already has a
 * collab that has not ended cannot be switched to exclusive (it would be exclusive to several
 * creators at once).
 */

export type ProductWriteResult = {
  productId: string
  status: ProductStatus
  /** Changed columns (snake_case); every column on create. */
  fields: string[]
  published: boolean
}

function columnsOf(fields: ProductFields) {
  return {
    title: fields.title,
    description: fields.description,
    targetUser: fields.targetUser,
    stage: fields.stage,
    demoUrl: fields.demoUrl,
    format: fields.format,
    targetPriceCents: fields.targetPrice,
    topics: fields.topics,
    preferredSplitBuilderPct: fields.preferredSplitBuilderPct,
    exclusivity: fields.exclusivity,
  }
}

const COLUMN_NAMES: Record<keyof ReturnType<typeof columnsOf>, string> = {
  title: PRODUCT_COLUMNS.title,
  description: PRODUCT_COLUMNS.description,
  targetUser: PRODUCT_COLUMNS.targetUser,
  stage: PRODUCT_COLUMNS.stage,
  demoUrl: PRODUCT_COLUMNS.demoUrl,
  format: PRODUCT_COLUMNS.format,
  targetPriceCents: PRODUCT_COLUMNS.targetPrice,
  topics: PRODUCT_COLUMNS.topics,
  preferredSplitBuilderPct: PRODUCT_COLUMNS.preferredSplitBuilderPct,
  exclusivity: PRODUCT_COLUMNS.exclusivity,
}

function assertPublishable(fields: Pick<ProductFields, "description" | "topics">): void {
  const problems = productPublishProblems(fields)
  if (Object.keys(problems).length > 0) {
    throw new ActionError("Finish these before publishing.", { fieldErrors: problems })
  }
}

/** A new product, saved as a draft or published at once (`intent`). */
export async function createProduct(
  database: DbOrTx,
  input: { userId: string; fields: ProductFields; intent: SupplyIntent },
): Promise<ProductWriteResult> {
  const publish = input.intent === "publish"
  if (publish) assertPublishable(input.fields)

  return withTransaction(async (tx) => {
    const [profile] = await tx
      .select({ id: builderProfiles.id })
      .from(builderProfiles)
      .where(eq(builderProfiles.userId, input.userId))
      .limit(1)
    if (!profile) throw new ActionError("Create your builder profile first.")

    const status: ProductStatus = publish ? "seeking" : "draft"
    const [product] = await tx
      .insert(products)
      .values({
        builderProfileId: profile.id,
        ...columnsOf(input.fields),
        currency: SUPPLY_CURRENCY,
        status,
        publishedAt: publish ? now() : null,
      })
      .returning({ id: products.id })
    if (!product) throw new Error("createProduct: no row returned")

    const subject = {
      actorUserId: input.userId,
      subjectType: "product",
      subjectId: product.id,
    } as const
    await track(
      "product.created",
      {
        ...subject,
        properties: {
          format: input.fields.format,
          stage: input.fields.stage,
          topics: eventTopics(input.fields.topics),
          target_price_cents: input.fields.targetPrice,
        },
      },
      tx,
    )
    if (publish) await track("product.published", { ...subject, properties: {} }, tx)
    return {
      productId: product.id,
      status,
      fields: Object.values(PRODUCT_COLUMNS),
      published: publish,
    }
  }, database)
}

type LockedProduct = ProductRow & { ownerUserId: string }

const { embedding: _embedding, ...productColumns } = getTableColumns(products)

async function lockOwnProduct(tx: Tx, userId: string, productId: string): Promise<LockedProduct> {
  const [row] = await tx
    .select({ product: productColumns, ownerUserId: builderProfiles.userId })
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .where(eq(products.id, productId))
    .for("update", { of: products })
  if (!row || row.ownerUserId !== userId) throw new ActionError("This product no longer exists.")
  return { ...row.product, ownerUserId: row.ownerUserId }
}

/**
 * Save the form on `/app/products/[id]`. With `intent: "publish"` a draft is published in the
 * same transaction (`product.updated` then `product.published`); on a published product it just
 * saves.
 */
export async function updateProduct(
  database: DbOrTx,
  input: { userId: string; productId: string; fields: ProductFields; intent: SupplyIntent },
): Promise<ProductWriteResult> {
  return withTransaction(async (tx) => {
    const current = await lockOwnProduct(tx, input.userId, input.productId)
    if (nextStatus("product", current.status, "edit") === null) {
      throw new ActionError(refusalMessage("product", current.status, "edit"))
    }
    const publish = input.intent === "publish" && current.status === "draft"
    if (publish) assertPublishable(input.fields)

    if (input.fields.exclusivity && !current.exclusivity) {
      // Under the product's row lock: an acceptance (which locks it too) cannot slip in between.
      if ((await countActiveCollabs(tx, current.id)) > 0) {
        throw new ActionError("This product already has a collab.", {
          fieldErrors: {
            exclusivity: [
              "It already has a collab, so it can't become exclusive until that collab ends.",
            ],
          },
        })
      }
    }

    const next = columnsOf(input.fields)
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((key) => {
      const before = current[key]
      const after = next[key]
      return Array.isArray(before) && Array.isArray(after)
        ? !sameList(before, after)
        : before !== after
    })
    const fields = changed.map((key) => COLUMN_NAMES[key])
    if (changed.length === 0 && !publish) {
      return { productId: current.id, status: current.status, fields: [], published: false }
    }

    const status: ProductStatus = publish ? "seeking" : current.status
    // Imported listings (CLAUDE.md §19.45): once the builder changes the text, syncs keep it; a
    // new description also drops the import's hook, so pages derive it from the new text.
    const textEdited = changed.some(
      (key) => key === "title" || key === "description" || key === "topics",
    )
    await tx
      .update(products)
      .set({
        ...next,
        status,
        ...(publish ? { publishedAt: now() } : {}),
        ...(textEdited && current.source !== "manual" ? { sourceEditedAt: now() } : {}),
        ...(changed.includes("description") ? { tagline: null } : {}),
      })
      .where(eq(products.id, current.id))

    const subject = {
      actorUserId: input.userId,
      subjectType: "product",
      subjectId: current.id,
    } as const
    if (fields.length > 0) {
      await track("product.updated", { ...subject, properties: { fields } }, tx)
    }
    if (publish) await track("product.published", { ...subject, properties: {} }, tx)
    return { productId: current.id, status, fields, published: publish }
  }, database)
}

export type ProductTransition = Exclude<SupplyAction, "edit">

/**
 * Publish, archive or restore a product (the buttons outside the form), as a conditional update
 * under the row lock (see lib/ideas/save.ts `transitionIdea`).
 */
export async function transitionProduct(
  database: DbOrTx,
  input: { userId: string; productId: string; action: ProductTransition },
): Promise<{ productId: string; from: ProductStatus; status: ProductStatus }> {
  return withTransaction(async (tx) => {
    const current = await lockOwnProduct(tx, input.userId, input.productId)
    const status = nextStatus("product", current.status, input.action)
    if (status === null) {
      throw new ActionError(refusalMessage("product", current.status, input.action))
    }
    if (input.action === "publish") assertPublishable(current)

    const at = now()
    const moved = await tx
      .update(products)
      .set({
        status,
        ...(input.action === "publish" ? { publishedAt: at } : {}),
        ...(input.action === "archive" ? { archivedAt: at } : {}),
        ...(input.action === "restore" ? { archivedAt: null } : {}),
      })
      .where(
        and(
          eq(products.id, current.id),
          inArray(products.status, statusesAllowing("product", input.action)),
        ),
      )
      .returning({ id: products.id })
    if (moved.length === 0) {
      throw new ActionError(refusalMessage("product", current.status, input.action))
    }

    const subject = {
      actorUserId: input.userId,
      subjectType: "product",
      subjectId: current.id,
    } as const
    switch (input.action) {
      case "publish":
        await track("product.published", { ...subject, properties: {} }, tx)
        break
      case "archive":
        await track(
          "product.archived",
          { ...subject, properties: { from_status: current.status } },
          tx,
        )
        break
      case "restore":
        await track("product.restored", { ...subject, properties: {} }, tx)
        break
    }
    return { productId: current.id, from: current.status, status }
  }, database)
}
