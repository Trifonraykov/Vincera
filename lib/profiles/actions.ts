"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { ACTION_MESSAGES, ActionError, defineAction } from "@/lib/actions/define-action"
import {
  canEditBuilderProfile,
  canEditCreatorProfile,
  canManageOwnAccount,
  canManagePortfolioItem,
} from "@/lib/auth/authz"
import { getDb, type Db } from "@/lib/db/client"
import { requestProfileEmbeddingRefresh } from "@/lib/embeddings/request"
import { runInBackground } from "@/lib/jobs/background"
import { completeOnboardingStep } from "@/lib/onboarding/complete-step"
import { loadOnboardingSnapshot } from "@/lib/onboarding/snapshot"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"
import { rateLimit, type RateLimitRule } from "@/lib/ratelimit"
import { revalidatePublicProfiles } from "@/lib/social/revalidate"

import {
  builderProfileFormSchema,
  creatorProfileFormSchema,
  type HandleAvailability,
  PROFILE_FORM_SOURCES,
  portfolioItemFormSchema,
  type PortfolioItemForm,
} from "./fields"
import { handleAvailability } from "./handles"
import {
  addPortfolioItem,
  deletePortfolioItem,
  findPortfolioItemOwner,
  updatePortfolioItem,
} from "./portfolio"
import {
  createPortfolioImageUpload,
  deletePortfolioImage,
  discardPortfolioUpload,
} from "./portfolio-image"
import { afterBuilderProfileSave, afterCreatorProfileSave } from "./after-save"
import { saveBuilderProfile, saveCreatorProfile } from "./save"

/**
 * Server actions for profiles (§4, §12): the creator and builder profile forms (onboarding step
 * and Settings → Profile), the live handle check, portfolio items and their images, and
 * "Continue" on the portfolio step. Each authorizes with lib/auth/authz.ts. After the commit,
 * the profile's embedding refresh is requested (`embeddings-refresh` job, §8 `semantic`, CLAUDE.md
 * §19.25) and public profile pages are revalidated.
 */

/** The live handle check runs as people type (debounced): 60 per user per minute. */
const HANDLE_CHECK_RATE_LIMIT: RateLimitRule = { limit: 60, window: "1 m" }
/** Project image upload URLs: 20 per user per hour. */
const PORTFOLIO_IMAGE_RATE_LIMIT: RateLimitRule = { limit: 20, window: "1 h" }

const sourceField = z.enum(PROFILE_FORM_SOURCES).default("settings")

function revalidatePaths(paths: Iterable<string>): void {
  for (const path of paths) revalidatePath(path)
}

/** The creator profile form: creates the profile (onboarding step) or saves changes. */
export const saveCreatorProfileAction = defineAction({
  name: "profiles.save_creator",
  input: creatorProfileFormSchema.extend({ from: sourceField }),
  authorize: (user) => canEditCreatorProfile(user),
  run: async ({ input, user, db }) => {
    const { from, ...form } = input
    const result = await saveCreatorProfile(db, { userId: user.id, form, source: from })
    await afterCreatorProfileSave(db, user.id, result)
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
    await afterBuilderProfileSave(db, user.id, result)
    if (from === "onboarding") redirect(result.nextStep ?? "/app")
    return { created: result.created, changed: result.fields.length > 0, handle: form.handle }
  },
})

/**
 * The live check under the handle field: available, yours, taken, reserved or invalid. Only a
 * hint; saving the profile claims the handle. A rate-limited check answers nothing useful, so the
 * field simply shows no status.
 */
export const checkHandleAvailabilityAction = defineAction({
  name: "profiles.check_handle",
  input: z.object({ handle: z.string().max(100) }),
  // Reads the public handle registry for the signed-in user's own form.
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ input, user, db }): Promise<HandleAvailability> => {
    const limit = await rateLimit("handle-check", user.id, HANDLE_CHECK_RATE_LIMIT)
    if (!limit.success) throw new ActionError("Too many checks. Keep typing, we'll check on save.")
    return handleAvailability(db, user.id, input.handle)
  },
})

// --- Portfolio ---------------------------------------------------------------------------------

const PORTFOLIO_PAGES = [ONBOARDING_STEP_PATHS["builder.portfolio"], "/app/settings/profile"]

async function afterPortfolioChange(
  db: Db,
  userId: string,
  removedImageKey: string | null = null,
): Promise<void> {
  if (removedImageKey) {
    await runInBackground("profiles", "portfolio_image_cleanup", () =>
      deletePortfolioImage(db, removedImageKey),
    )
  }
  await requestProfileEmbeddingRefresh(userId, "builder", db)
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

/** A signed upload URL for a project image (the browser PUTs the file, then saves the project). */
export const requestPortfolioImageUpload = defineAction({
  name: "profiles.portfolio_image_upload_url",
  input: z.object({
    contentType: z.string().min(1).max(100),
    sizeBytes: z.number().int().nonnegative(),
  }),
  authorize: (user) => canEditBuilderProfile(user),
  run: async ({ input, user }) => {
    const limit = await rateLimit("portfolio-image-upload", user.id, PORTFOLIO_IMAGE_RATE_LIMIT)
    if (!limit.success) {
      throw new ActionError("Too many uploads in a short time. Please try again later.")
    }
    return createPortfolioImageUpload({ userId: user.id, ...input })
  },
})

/**
 * The project actions parse the project's fields in `run`, not in `input`, so that every refusal
 * (invalid fields included) deletes the image the browser just uploaded (CLAUDE.md §19.19). The
 * save itself deletes it after accepting or refusing it.
 */
const portfolioActionInput = z.looseObject({ from: sourceField, imageKey: z.unknown().optional() })

async function parsePortfolioForm(
  userId: string,
  fields: Record<string, unknown>,
): Promise<PortfolioItemForm> {
  const parsed = portfolioItemFormSchema.safeParse(fields)
  if (parsed.success) return parsed.data
  await discardPortfolioUpload(userId, fields.imageKey)
  const { formErrors, fieldErrors } = z.flattenError(parsed.error)
  throw new ActionError(formErrors[0] ?? ACTION_MESSAGES.invalidInput, { fieldErrors })
}

export const addPortfolioItemAction = defineAction({
  name: "profiles.portfolio_add",
  input: portfolioActionInput,
  authorize: (user) => canEditBuilderProfile(user),
  run: async ({ input, user, db }) => {
    const { from, ...fields } = input
    const form = await parsePortfolioForm(user.id, fields)
    const result = await addPortfolioItem(db, { userId: user.id, form, source: from })
    await afterPortfolioChange(db, user.id)
    return result
  },
})

export const updatePortfolioItemAction = defineAction({
  name: "profiles.portfolio_update",
  input: portfolioActionInput.extend({ itemId: itemIdField }),
  authorize: (user, { itemId }) => ownsPortfolioItem(user, itemId),
  run: async ({ input, user, db }) => {
    const { from, itemId, ...fields } = input
    const form = await parsePortfolioForm(user.id, fields)
    const updated = await updatePortfolioItem(db, { userId: user.id, itemId, form, source: from })
    if (!updated) throw new ActionError("This project was removed. Refresh the page.")
    await afterPortfolioChange(db, user.id, updated.removedImageKey)
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
    await afterPortfolioChange(db, user.id, deleted.removedImageKey)
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
