import "server-only"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  canCreateIdea,
  canCreateProduct,
  canManageIdea,
  canManageProduct,
  canViewIdea,
  canViewProduct,
  hasRole,
} from "@/lib/auth/authz"
import type { AuthUser } from "@/lib/auth/user"
import type { Db } from "@/lib/db/client"
import { requestEmbeddingRefreshAfterCommit } from "@/lib/embeddings/request"
import { ideaFormSchema } from "@/lib/ideas/fields"
import { findCreatorContext, findIdea, findIdeaAccess, listOwnIdeas } from "@/lib/ideas/queries"
import { createIdea, transitionIdea, updateIdea } from "@/lib/ideas/save"
import { productFormSchema } from "@/lib/products/fields"
import {
  findBuilderProfileId,
  findProduct,
  findProductAccess,
  listOwnProducts,
} from "@/lib/products/queries"
import { createProduct, transitionProduct, updateProduct } from "@/lib/products/save"
import { ownerActions } from "@/lib/supply/lifecycle"

import { forbidden, notFound } from "../errors"
import { endpoint, parseForm, uuidParam, type Endpoint } from "../router"
import {
  SUPPLY_FILTER_VALUES,
  ideaDetailSchema,
  ideaFormInput,
  ideaListOutput,
  productDetailSchema,
  productFormInput,
  productListOutput,
  supplySavedOutput,
  supplyStatusInput,
} from "../schemas"

/**
 * Ideas and products (§12 `/app/ideas/*`, `/app/products/*`; CLAUDE.md §19.25): the same form
 * schemas, services and authz rules as the web's server actions, and after every committed change
 * the same embedding refresh request (which asks matching to recompute) and revalidations.
 */

const listQuery = z.object({ status: z.enum(SUPPLY_FILTER_VALUES).default("all") })

async function afterIdeaChange(ideaId: string): Promise<void> {
  await requestEmbeddingRefreshAfterCommit({ type: "idea", id: ideaId })
  revalidatePath("/app/ideas")
  revalidatePath(`/app/ideas/${ideaId}`)
  revalidatePath("/app")
}

async function afterProductChange(productId: string): Promise<void> {
  await requestEmbeddingRefreshAfterCommit({ type: "product", id: productId })
  revalidatePath("/app/products")
  revalidatePath(`/app/products/${productId}`)
  revalidatePath("/app")
}

async function requireOwnIdea(db: Db, user: AuthUser, ideaId: string): Promise<void> {
  const access = await findIdeaAccess(db, ideaId)
  if (!access) throw notFound()
  if (!canManageIdea(user, access)) {
    // Someone else's idea: they may see it (published) but not change it.
    throw canViewIdea(user, access) ? forbidden() : notFound()
  }
}

async function requireOwnProduct(db: Db, user: AuthUser, productId: string): Promise<void> {
  const access = await findProductAccess(db, productId)
  if (!access) throw notFound()
  if (!canManageProduct(user, access)) {
    throw canViewProduct(user, access) ? forbidden() : notFound()
  }
}

async function ideaDetail(db: Db, user: AuthUser, ideaId: string) {
  const idea = await findIdea(db, ideaId)
  // Drafts and archived ideas are private: a stranger gets the same 404 as for an unknown id.
  if (!idea || !canViewIdea(user, { ownerUserId: idea.owner.userId, status: idea.status })) {
    throw notFound()
  }
  const isOwner = canManageIdea(user, { ownerUserId: idea.owner.userId })
  return {
    ...idea,
    isOwner,
    ownerActions: isOwner ? [...ownerActions("idea", idea.status)] : [],
    canPropose: !isOwner && idea.status === "open" && hasRole(user, "builder"),
  }
}

async function productDetail(db: Db, user: AuthUser, productId: string) {
  const product = await findProduct(db, productId)
  const access = product ? { ownerUserId: product.owner.userId, status: product.status } : null
  if (!product || !access || !canViewProduct(user, access)) throw notFound()
  const isOwner = canManageProduct(user, access)
  return {
    ...product,
    isOwner,
    ownerActions: isOwner ? [...ownerActions("product", product.status)] : [],
    canPropose: !isOwner && product.status === "seeking" && hasRole(user, "creator"),
  }
}

export const supplyEndpoints: Endpoint[] = [
  // --- Ideas ---
  endpoint({
    method: "GET",
    path: "/ideas",
    auth: "onboarded",
    query: listQuery,
    output: ideaListOutput,
    run: async ({ db, user, query }) => {
      if (!canCreateIdea(user)) throw forbidden()
      const hasProfile = (await findCreatorContext(db, user.id)) !== null
      return {
        hasProfile,
        items: hasProfile ? await listOwnIdeas(db, user.id, query.status) : [],
      }
    },
  }),
  endpoint({
    method: "POST",
    path: "/ideas",
    auth: "onboarded",
    input: ideaFormInput,
    output: supplySavedOutput,
    run: async ({ db, user, input }) => {
      if (!canCreateIdea(user)) throw forbidden()
      const { intent, ...fields } = parseForm(ideaFormSchema, input)
      const result = await createIdea(db, { userId: user.id, fields, intent, brief: null })
      await afterIdeaChange(result.ideaId)
      return { id: result.ideaId, status: result.status, published: result.published }
    },
  }),
  endpoint({
    method: "GET",
    path: "/ideas/:id",
    auth: "onboarded",
    output: ideaDetailSchema,
    run: ({ db, user, params }) => ideaDetail(db, user, uuidParam(params)),
  }),
  endpoint({
    method: "PATCH",
    path: "/ideas/:id",
    auth: "onboarded",
    input: ideaFormInput,
    output: supplySavedOutput,
    run: async ({ db, user, params, input }) => {
      const ideaId = uuidParam(params)
      await requireOwnIdea(db, user, ideaId)
      const { intent, ...fields } = parseForm(ideaFormSchema, input)
      const result = await updateIdea(db, { userId: user.id, ideaId, fields, intent })
      if (result.fields.length > 0 || result.published) await afterIdeaChange(ideaId)
      return { id: ideaId, status: result.status, published: result.published }
    },
  }),
  endpoint({
    method: "POST",
    path: "/ideas/:id/status",
    auth: "onboarded",
    input: supplyStatusInput,
    output: supplySavedOutput,
    run: async ({ db, user, params, input }) => {
      const ideaId = uuidParam(params)
      await requireOwnIdea(db, user, ideaId)
      const result = await transitionIdea(db, { userId: user.id, ideaId, action: input.action })
      await afterIdeaChange(ideaId)
      return { id: ideaId, status: result.status, published: input.action === "publish" }
    },
  }),

  // --- Products ---
  endpoint({
    method: "GET",
    path: "/products",
    auth: "onboarded",
    query: listQuery,
    output: productListOutput,
    run: async ({ db, user, query }) => {
      if (!canCreateProduct(user)) throw forbidden()
      const hasProfile = (await findBuilderProfileId(db, user.id)) !== null
      return {
        hasProfile,
        items: hasProfile ? await listOwnProducts(db, user.id, query.status) : [],
      }
    },
  }),
  endpoint({
    method: "POST",
    path: "/products",
    auth: "onboarded",
    input: productFormInput,
    output: supplySavedOutput,
    run: async ({ db, user, input }) => {
      if (!canCreateProduct(user)) throw forbidden()
      const { intent, ...fields } = parseForm(productFormSchema, input)
      const result = await createProduct(db, { userId: user.id, fields, intent })
      await afterProductChange(result.productId)
      return { id: result.productId, status: result.status, published: result.published }
    },
  }),
  endpoint({
    method: "GET",
    path: "/products/:id",
    auth: "onboarded",
    output: productDetailSchema,
    run: ({ db, user, params }) => productDetail(db, user, uuidParam(params)),
  }),
  endpoint({
    method: "PATCH",
    path: "/products/:id",
    auth: "onboarded",
    input: productFormInput,
    output: supplySavedOutput,
    run: async ({ db, user, params, input }) => {
      const productId = uuidParam(params)
      await requireOwnProduct(db, user, productId)
      const { intent, ...fields } = parseForm(productFormSchema, input)
      const result = await updateProduct(db, { userId: user.id, productId, fields, intent })
      if (result.fields.length > 0 || result.published) await afterProductChange(productId)
      return { id: productId, status: result.status, published: result.published }
    },
  }),
  endpoint({
    method: "POST",
    path: "/products/:id/status",
    auth: "onboarded",
    input: supplyStatusInput,
    output: supplySavedOutput,
    run: async ({ db, user, params, input }) => {
      const productId = uuidParam(params)
      await requireOwnProduct(db, user, productId)
      const result = await transitionProduct(db, {
        userId: user.id,
        productId,
        action: input.action,
      })
      await afterProductChange(productId)
      return { id: productId, status: result.status, published: input.action === "publish" }
    },
  }),
]
