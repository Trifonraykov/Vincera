import "server-only"

import { and, count, desc, eq, getTableColumns, inArray, ne } from "drizzle-orm"

import type { ProductAccess } from "@/lib/auth/authz"
import type { DbOrTx } from "@/lib/db/client"
import { builderProfiles, collabs, products, type ProductStatus } from "@/lib/db/schema"
import { statusesForFilter, type SupplyFilter } from "@/lib/supply/lifecycle"

/**
 * Reads for `/app/products`, `/app/products/[id]` and the product actions. Every read shown to
 * someone other than the owner goes through `canViewProduct` first (the page does it).
 */

/** Every column but the vector (1024 numbers no page or action needs). */
const { embedding: _embedding, ...productColumns } = getTableColumns(products)

export type ProductRow = Omit<typeof products.$inferSelect, "embedding">

export type ProductRecord = ProductRow & {
  owner: { userId: string; handle: string; displayName: string }
}

/** One product with its owner, or null for an unknown id. */
export async function findProduct(
  database: DbOrTx,
  productId: string,
): Promise<ProductRecord | null> {
  const [row] = await database
    .select({
      product: productColumns,
      ownerUserId: builderProfiles.userId,
      ownerHandle: builderProfiles.handle,
      ownerDisplayName: builderProfiles.displayName,
    })
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .where(eq(products.id, productId))
    .limit(1)
  if (!row) return null
  return {
    ...row.product,
    owner: { userId: row.ownerUserId, handle: row.ownerHandle, displayName: row.ownerDisplayName },
  }
}

/** What `canManageProduct` / `canViewProduct` need, or null for an unknown id. */
export async function findProductAccess(
  database: DbOrTx,
  productId: string,
): Promise<ProductAccess | null> {
  const [row] = await database
    .select({ ownerUserId: builderProfiles.userId, status: products.status })
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .where(eq(products.id, productId))
    .limit(1)
  return row ?? null
}

export type ProductListItem = Pick<
  ProductRecord,
  | "id"
  | "title"
  | "format"
  | "stage"
  | "targetPriceCents"
  | "currency"
  | "topics"
  | "status"
  | "exclusivity"
  | "publishedAt"
  | "updatedAt"
>

/** The builder's own products for the list page, newest change first. */
export async function listOwnProducts(
  database: DbOrTx,
  userId: string,
  filter: SupplyFilter,
): Promise<ProductListItem[]> {
  return database
    .select({
      id: products.id,
      title: products.title,
      format: products.format,
      stage: products.stage,
      targetPriceCents: products.targetPriceCents,
      currency: products.currency,
      topics: products.topics,
      status: products.status,
      exclusivity: products.exclusivity,
      publishedAt: products.publishedAt,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .where(
      and(
        eq(builderProfiles.userId, userId),
        inArray(products.status, statusesForFilter("product", filter)),
      ),
    )
    .orderBy(desc(products.updatedAt), desc(products.id))
}

/** How many of the builder's products are in each status (the filter chips' counts). */
export async function countOwnProducts(
  database: DbOrTx,
  userId: string,
): Promise<Record<ProductStatus, number>> {
  const rows = await database
    .select({ status: products.status, total: count() })
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .where(eq(builderProfiles.userId, userId))
    .groupBy(products.status)
  const counts: Record<ProductStatus, number> = {
    draft: 0,
    seeking: 0,
    in_collab: 0,
    launched: 0,
    archived: 0,
  }
  for (const row of rows) counts[row.status] = row.total
  return counts
}

/** Collabs on this product that have not ended (a non-exclusive product may have several). */
export async function countActiveCollabs(database: DbOrTx, productId: string): Promise<number> {
  const [row] = await database
    .select({ total: count() })
    .from(collabs)
    .where(and(eq(collabs.productId, productId), ne(collabs.stage, "ended")))
  return row?.total ?? 0
}

/** The builder profile products belong to, or null when the builder has none yet. */
export async function findBuilderProfileId(
  database: DbOrTx,
  userId: string,
): Promise<string | null> {
  const [profile] = await database
    .select({ id: builderProfiles.id })
    .from(builderProfiles)
    .where(eq(builderProfiles.userId, userId))
    .limit(1)
  return profile?.id ?? null
}
