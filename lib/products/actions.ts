"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { defineAction } from "@/lib/actions/define-action"
import { canCreateProduct, canManageProduct } from "@/lib/auth/authz"
import type { AuthUser } from "@/lib/auth/user"
import { getDb } from "@/lib/db/client"
import { requestEmbeddingRefreshAfterCommit } from "@/lib/embeddings/request"

import { productFormSchema } from "./fields"
import { findProductAccess } from "./queries"
import { createProduct, transitionProduct, updateProduct } from "./save"

/**
 * Server actions for products (§4, §12 `/app/products/*`; CLAUDE.md §19.25): create, save (and
 * publish), archive / restore. Each authorizes with lib/auth/authz.ts (`canCreateProduct`,
 * `canManageProduct` on the stored owner). After the commit the embedding refresh is requested
 * (which then asks matching to recompute) and the pages are revalidated.
 */

const productIdField = z.uuid({ error: "Unknown product." })

async function ownsProduct(user: AuthUser, productId: string): Promise<boolean> {
  const access = await findProductAccess(getDb(), productId)
  return access !== null && canManageProduct(user, access)
}

async function afterProductChange(productId: string): Promise<void> {
  await requestEmbeddingRefreshAfterCommit({ type: "product", id: productId })
  revalidatePath("/app/products")
  revalidatePath(`/app/products/${productId}`)
  revalidatePath("/app")
}

/** `/app/products/new`: save a draft or publish at once, then open the product. */
export const createProductAction = defineAction({
  name: "products.create",
  input: productFormSchema,
  authorize: (user) => canCreateProduct(user),
  run: async ({ input, user, db }) => {
    const { intent, ...fields } = input
    const result = await createProduct(db, { userId: user.id, fields, intent })
    await afterProductChange(result.productId)
    redirect(
      `/app/products/${result.productId}?saved=${result.published ? "published" : "created"}`,
    )
  },
})

/** `/app/products/[id]`: save the form; "Publish" on a draft also publishes it. */
export const updateProductAction = defineAction({
  name: "products.update",
  input: productFormSchema.extend({ productId: productIdField }),
  authorize: (user, { productId }) => ownsProduct(user, productId),
  run: async ({ input, user, db }) => {
    const { productId, intent, ...fields } = input
    const result = await updateProduct(db, { userId: user.id, productId, fields, intent })
    if (result.fields.length > 0 || result.published) await afterProductChange(productId)
    return { status: result.status, published: result.published, changed: result.fields }
  },
})

/** Publish (from a draft), archive or restore. */
export const changeProductStatusAction = defineAction({
  name: "products.change_status",
  input: z.object({
    productId: productIdField,
    action: z.enum(["publish", "archive", "restore"], { error: "Unknown action." }),
  }),
  authorize: (user, { productId }) => ownsProduct(user, productId),
  run: async ({ input, user, db }) => {
    const result = await transitionProduct(db, {
      userId: user.id,
      productId: input.productId,
      action: input.action,
    })
    await afterProductChange(input.productId)
    return { status: result.status }
  },
})
