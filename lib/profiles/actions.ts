"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import {
  canEditBuilderProfile,
  canEditCreatorProfile,
  canManagePortfolioItem,
} from "@/lib/auth/authz"
import { getDb, type Db } from "@/lib/db/client"
import { runInBackground } from "@/lib/jobs/background"
import { completeOnboardingStep } from "@/lib/onboarding/complete-step"
import { loadOnboardingSnapshot } from "@/lib/onboarding/snapshot"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"
import { refreshCreatorEmbedding } from "@/lib/social/derived"
import { publicProfilePaths, revalidatePublicProfiles } from "@/lib/social/revalidate"

import { refreshBuilderEmbedding } from "./embedding"
import {
  builderProfileFormSchema,
  creatorProfileFormSchema,
  PROFILE_FORM_SOURCES,
  portfolioItemFormSchema,
} from "./fields"
import {
  addPortfolioItem,
  deletePortfolioItem,
  findPortfolioItemOwner,
  updatePortfolioItem,
} from "./portfolio"
import { saveBuilderProfile, saveCreatorProfile, type ProfileSaveResult } from "./save"

/**
 * Server actions for profiles (§4, §12): the creator and builder profile forms (onboarding step
 * and Settings → Profile), portfolio items, and "Continue" on the portfolio step. Each authorizes
 * with lib/auth/authz.ts. After the commit, embeddings are refreshed in the background (§8
 * `semantic`) and public profile pages are revalidated.
 */

const sourceField = z.enum(PROFILE_FORM_SOURCES).default("settings")

/** Columns whose change alters the embedding text (lib/social/derived.ts, ./embedding.ts). */
const CREATOR_EMBEDDED = new Set(["niche", "bio", "languages", "country"])
const BUILDER_EMBEDDED = new Set(["bio", "skills", "stack"])

const PROFILE_PAGES = ["/app/settings/profile", "/app/audience", "/app"] as const

function revalidatePaths(paths: Iterable<string>): void {
  for (const path of paths) revalidatePath(path)
}

async function afterProfileSave(
  db: Db,
  userId: string,
  result: ProfileSaveResult,
  embedded: ReadonlySet<string>,
  reembed: (db: Db, userId: string) => Promise<unknown>,
): Promise<void> {
  if (result.created || result.fields.some((field) => embedded.has(field))) {
    await runInBackground("profiles", "profile_embedding", () => reembed(db, userId))
  }
  if (result.created || result.fields.length > 0) {
    await revalidatePublicProfiles(db, userId)
    if (result.previousHandle) revalidatePaths(publicProfilePaths(result.previousHandle))
    revalidatePaths(PROFILE_PAGES)
  }
}

/** The creator profile form: creates the profile (onboarding step) or saves changes. */
export const saveCreatorProfileAction = defineAction({
  name: "profiles.save_creator",
  input: creatorProfileFormSchema.extend({ from: sourceField }),
  authorize: (user) => canEditCreatorProfile(user),
  run: async ({ input, user, db }) => {
    const { from, ...form } = input
    const result = await saveCreatorProfile(db, { userId: user.id, form, source: from })
    await afterProfileSave(db, user.id, result, CREATOR_EMBEDDED, refreshCreatorEmbedding)
    if (from === "onboarding") redirect(result.nextStep ?? "/app")
    return { created: result.created, changed: result.fields.length > 0, handle: form.handle }
  },
})

/** The builder profile form: creates the profile (onboarding step) or saves changes. */
export const saveBuilderProfileAction = defineAction({
  name: "profiles.save_builder",
  input: builderProfileFormSchema.extend({ from: sourceField }),
  authorize: (user) => canEditBuilderProfile(user),
  run: async ({ input, user, db }) => {
    const { from, ...form } = input
    const result = await saveBuilderProfile(db, { userId: user.id, form, source: from })
    await afterProfileSave(db, user.id, result, BUILDER_EMBEDDED, refreshBuilderEmbedding)
    if (from === "onboarding") redirect(result.nextStep ?? "/app")
    return { created: result.created, changed: result.fields.length > 0, handle: form.handle }
  },
})

// --- Portfolio ---------------------------------------------------------------------------------

const PORTFOLIO_PAGES = [ONBOARDING_STEP_PATHS["builder.portfolio"], "/app/settings/profile"]

async function afterPortfolioChange(db: Db, userId: string): Promise<void> {
  await runInBackground("profiles", "builder_embedding", () => refreshBuilderEmbedding(db, userId))
  await revalidatePublicProfiles(db, userId)
  revalidatePaths(PORTFOLIO_PAGES)
}

const itemIdField = z.uuid({ error: "Unknown project." })

async function ownsPortfolioItem(
  user: Parameters<typeof canManagePortfolioItem>[0],
  itemId: string,
): Promise<boolean> {
  const owner = await findPortfolioItemOwner(getDb(), itemId)
  return owner !== null && canManagePortfolioItem(user, owner)
}

export const addPortfolioItemAction = defineAction({
  name: "profiles.portfolio_add",
  input: portfolioItemFormSchema.extend({ from: sourceField }),
  authorize: (user) => canEditBuilderProfile(user),
  run: async ({ input, user, db }) => {
    const { from, ...form } = input
    const result = await addPortfolioItem(db, { userId: user.id, form, source: from })
    await afterPortfolioChange(db, user.id)
    return result
  },
})

export const updatePortfolioItemAction = defineAction({
  name: "profiles.portfolio_update",
  input: portfolioItemFormSchema.extend({ itemId: itemIdField, from: sourceField }),
  authorize: (user, { itemId }) => ownsPortfolioItem(user, itemId),
  run: async ({ input, user, db }) => {
    const { from, itemId, ...form } = input
    const updated = await updatePortfolioItem(db, { userId: user.id, itemId, form, source: from })
    if (!updated) throw new ActionError("This project was removed. Refresh the page.")
    await afterPortfolioChange(db, user.id)
    return { itemId }
  },
})

export const deletePortfolioItemAction = defineAction({
  name: "profiles.portfolio_delete",
  input: z.object({ itemId: itemIdField, from: sourceField }),
  authorize: (user, { itemId }) => ownsPortfolioItem(user, itemId),
  run: async ({ input, user, db }) => {
    const deleted = await deletePortfolioItem(db, {
      userId: user.id,
      itemId: input.itemId,
      source: input.from,
    })
    if (!deleted) throw new ActionError("This project was already removed.")
    await afterPortfolioChange(db, user.id)
    return { itemId: input.itemId }
  },
})

/** "Continue" on /onboarding/builder/portfolio: record the step as done and move on. */
export const finishPortfolioStep = defineAction({
  name: "profiles.portfolio_finish",
  input: z.object({}),
  authorize: (user) => canEditBuilderProfile(user),
  run: async ({ user, db }) => {
    const snapshot = await loadOnboardingSnapshot(db, user.id)
    if (!snapshot || (snapshot.portfolioItemCount === 0 && snapshot.githubConnectionCount === 0)) {
      throw new ActionError("Add a project or connect GitHub first, or choose “Do this later”.")
    }
    const { nextStep } = await completeOnboardingStep(db, {
      userId: user.id,
      step: "builder.portfolio",
      status: "done",
    })
    redirect(nextStep ?? "/app")
  },
})
