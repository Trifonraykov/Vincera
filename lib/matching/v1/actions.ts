"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import { canManageMatchingModels } from "@/lib/auth/authz"
import { env } from "@/lib/env"
import { enqueue } from "@/lib/jobs/enqueue"
import { reportError } from "@/lib/observability"
import { rateLimit } from "@/lib/ratelimit"

import { activateMatchingModel, deactivateMatchingModel } from "./activation"
import { trainMatchingModel } from "./train"
import { InsufficientTrainingDataError } from "./train-core"

/**
 * `/admin/matching` actions (CLAUDE.md §19.38, §19.42): train a v1 model (stored inactive), and
 * activate or deactivate a version. Admins only (`canManageMatchingModels`); every change is
 * audited in the same transaction.
 *
 * Training runs in the request (a few thousand rows fit in well under a second) so the admin sees
 * the result or the plain "not enough history" reason at once; the `matching-train` job runs the
 * same code for the CLI path and background use.
 */

const modelVersion = z
  .string()
  .regex(/^(v0|v1-\d{4}-\d{2}-\d{2}(-\d{1,3})?)$/, { error: "That model version is not valid." })

function flags() {
  return {
    MATCHING_MODEL_VERSION: env.MATCHING_MODEL_VERSION,
    MATCHING_V1_FORCE: env.MATCHING_V1_FORCE,
  }
}

function revalidateMatching(): void {
  revalidatePath("/admin/matching")
  revalidatePath("/app/discover", "layout")
  revalidatePath("/app")
}

/** Lists switch versions on recompute: ask for everyone's (the nightly fan-out), best effort. */
async function requestRecomputeForEveryone(): Promise<void> {
  try {
    await enqueue("matching/nightly.requested", {})
  } catch (error) {
    reportError(error, { tags: { area: "matching-v1" } })
  }
}

export const trainMatchingModelAction = defineAction({
  name: "matching.train",
  input: z.object({}),
  authorize: (user) => canManageMatchingModels(user),
  run: async ({ user, db }) => {
    const limit = await rateLimit("matching-train", user.id, { limit: 3, window: "1 h" })
    if (!limit.success) {
      throw new ActionError("You've trained three times in the last hour. Try again later.")
    }
    try {
      const trained = await trainMatchingModel(db, { requestedByUserId: user.id })
      revalidateMatching()
      return { modelVersion: trained.modelVersion }
    } catch (error) {
      if (error instanceof InsufficientTrainingDataError) throw new ActionError(error.message)
      throw error
    }
  },
})

export const activateMatchingModelAction = defineAction({
  name: "matching.activate",
  input: z.object({ modelVersion }),
  authorize: (user) => canManageMatchingModels(user),
  run: async ({ user, db, input }) => {
    const result = await activateMatchingModel(db, {
      adminUserId: user.id,
      modelVersion: input.modelVersion,
      flags: flags(),
    })
    await requestRecomputeForEveryone()
    revalidateMatching()
    return result
  },
})

export const deactivateMatchingModelAction = defineAction({
  name: "matching.deactivate",
  input: z.object({ modelVersion }),
  authorize: (user) => canManageMatchingModels(user),
  run: async ({ user, db, input }) => {
    const result = await deactivateMatchingModel(db, {
      adminUserId: user.id,
      modelVersion: input.modelVersion,
      flags: flags(),
    })
    await requestRecomputeForEveryone()
    revalidateMatching()
    return result
  },
})
