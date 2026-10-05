"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import { canEditCreatorProfile } from "@/lib/auth/authz"
import { getDb, withTransaction } from "@/lib/db/client"
import { enqueue } from "@/lib/jobs/enqueue"
import { completeOnboardingStep } from "@/lib/onboarding/complete-step"
import { loadOnboardingSnapshot } from "@/lib/onboarding/snapshot"
import { rateLimit, type RateLimitRule } from "@/lib/ratelimit"

import {
  canConnectSocial,
  canManageSocialConnection,
  canVerifySocialConnection,
  canViewOwnAudience,
} from "./authz"
import { isSocialOAuthAvailable } from "./availability"
import { runInBackground } from "./background"
import { SOCIAL_PROVIDER_META } from "./catalog"
import { disconnectConnection } from "./connections"
import { recomputeSizeTier, refreshAudienceSummary, refreshCreatorEmbedding } from "./derived"
import {
  createEvidenceUpload,
  deleteEvidenceObject,
  discardUnusedEvidence,
  submitManualEntry,
  verifyManualConnection,
} from "./manual"
import { manualProviderSchema } from "./manual-policy"
import { findConnectionInfo } from "./queries"
import { revalidatePublicProfiles } from "./revalidate"
import { revokeTokens } from "./revoke"
import { CreatorProfileMissingError, reviewAudienceSummary } from "./summary"
import { audienceSummaryFormSchema } from "./summary-form"

/**
 * Server actions for social connections and the audience summary (§4, §7.1, §7.3; CLAUDE.md
 * §19.14): resync, disconnect, the manual-entry fallback, the creator's review and edits of the
 * audience summary, "Regenerate", the onboarding connect step, and the admin's verification of
 * manual entries. Each one authorizes with lib/social/authz.ts.
 */

/** "Resync" on a connection: 3 per connection per 15 minutes (provider quotas, LLM cost). */
const RESYNC_RATE_LIMIT: RateLimitRule = { limit: 3, window: "15 m" }
/** Screenshot upload URLs: 10 per user per hour. */
const EVIDENCE_UPLOAD_RATE_LIMIT: RateLimitRule = { limit: 10, window: "1 h" }
/** Saving manual numbers: 10 per user per hour (each writes a snapshot and a new summary). */
const MANUAL_SUBMIT_RATE_LIMIT: RateLimitRule = { limit: 10, window: "1 h" }
/** "Regenerate" the audience summary: 5 per user per hour (each is a model call). */
const REGENERATE_RATE_LIMIT: RateLimitRule = { limit: 5, window: "1 h" }

const SOCIAL_PAGES = [
  "/app/settings/connections",
  "/app/audience",
  "/onboarding/creator/connect",
  "/onboarding/creator/review",
] as const

function revalidateSocialPages(): void {
  for (const path of SOCIAL_PAGES) revalidatePath(path)
}

const connectionIdInput = z.object({ connectionId: z.uuid({ error: "Unknown connection." }) })

async function ownsConnection(
  user: { id: string; status: "active" | "suspended" },
  connectionId: string,
): Promise<boolean> {
  const connection = await findConnectionInfo(getDb(), connectionId)
  return connection !== null && canManageSocialConnection(user, connection)
}

/** Refresh the creator's summary and embedding after the response (never blocks, §7.3). */
async function refreshCreatorInBackground(userId: string): Promise<void> {
  await runInBackground("creator_derived", async () => {
    const db = getDb()
    await refreshAudienceSummary(db, userId)
    await refreshCreatorEmbedding(db, userId)
    await revalidatePublicProfiles(db, userId)
  })
}

// --- Resync / disconnect -----------------------------------------------------------------------

export const resyncSocialConnection = defineAction({
  name: "social.resync",
  input: connectionIdInput,
  authorize: (user, { connectionId }) => ownsConnection(user, connectionId),
  run: async ({ input, db }) => {
    const connection = await findConnectionInfo(db, input.connectionId)
    if (!connection) throw new ActionError("This connection no longer exists.")
    const label = SOCIAL_PROVIDER_META[connection.provider].label
    if (connection.source === "manual") {
      throw new ActionError(
        `Numbers you entered by hand don't sync. Update them, or connect ${label} to sync automatically.`,
      )
    }
    if (!isSocialOAuthAvailable(connection.provider)) {
      throw new ActionError(`Syncing ${label} isn't available right now. Please try again later.`)
    }
    if (connection.status !== "active") {
      throw new ActionError(`Your ${label} access expired. Reconnect ${label} to sync again.`)
    }
    const limit = await rateLimit("social-resync", connection.id, RESYNC_RATE_LIMIT)
    if (!limit.success) {
      throw new ActionError(
        `You've synced ${label} a few times already. Try again in a little while.`,
      )
    }
    await enqueue("social/sync.requested", { connectionId: connection.id, reason: "manual" })
    revalidateSocialPages()
    return { queued: true as const }
  },
})

export const disconnectSocialConnection = defineAction({
  name: "social.disconnect",
  input: connectionIdInput,
  authorize: (user, { connectionId }) => ownsConnection(user, connectionId),
  run: async ({ input, user, db }) => {
    const removed = await disconnectConnection(db, {
      connectionId: input.connectionId,
      userId: user.id,
      afterDelete: async (tx) => {
        await recomputeSizeTier(tx, user.id)
      },
    })
    if (!removed) throw new ActionError("This connection was already removed.")

    // After the commit: tokens are already gone from our database (§14); the rest is best effort.
    const { tokens, provider, evidenceKey } = removed
    await runInBackground("social_revoke", async () => {
      if (tokens) await revokeTokens(provider, tokens)
      await deleteEvidenceObject(evidenceKey)
    })
    if (provider !== "github") await refreshCreatorInBackground(user.id)
    else await revalidatePublicProfiles(db, user.id)
    revalidateSocialPages()
    return { provider }
  },
})

// --- Manual entry (§7.1 fallback) --------------------------------------------------------------

export const requestEvidenceUpload = defineAction({
  name: "social.manual_upload_url",
  input: z.object({
    provider: manualProviderSchema,
    contentType: z.string().min(1).max(100),
    sizeBytes: z.number().int().nonnegative(),
  }),
  authorize: (user, { provider }) => canConnectSocial(user, provider),
  run: async ({ input, user }) => {
    const limit = await rateLimit("social-evidence-upload", user.id, EVIDENCE_UPLOAD_RATE_LIMIT)
    if (!limit.success) {
      throw new ActionError("Too many uploads in a short time. Please try again later.")
    }
    return createEvidenceUpload({ userId: user.id, ...input })
  },
})

export const submitManualConnection = defineAction({
  name: "social.manual_submit",
  // The count and link are checked in `submitManualEntry` (checkManualEntryFields), after the
  // screenshot was uploaded, so that a refusal can delete the upload.
  input: z.object({
    provider: manualProviderSchema,
    followers: z.union([z.string().max(100), z.number()]),
    profileUrl: z.string().max(2000),
    evidenceKey: z.string().min(1, "Upload a screenshot of your follower count.").max(512),
  }),
  authorize: (user, { provider }) => canConnectSocial(user, provider),
  run: async ({ input, user, db }) => {
    const entry = { userId: user.id, ...input }
    const limit = await rateLimit("social-manual-submit", user.id, MANUAL_SUBMIT_RATE_LIMIT)
    if (!limit.success) {
      await discardUnusedEvidence(db, entry)
      throw new ActionError(
        "You've saved your numbers several times in a short time. Please try again later.",
      )
    }
    const result = await submitManualEntry(db, entry)
    if (!result.unchanged) {
      await runInBackground("social_evidence_cleanup", () =>
        deleteEvidenceObject(result.replacedEvidenceKey),
      )
      await refreshCreatorInBackground(user.id)
      revalidateSocialPages()
    }
    return { connectionId: result.connectionId, created: result.created }
  },
})

/** Admin: confirm a manual entry after checking its screenshot (admin UI arrives in Phase 6). */
export const verifySocialConnection = defineAction({
  name: "social.verify_manual",
  input: connectionIdInput,
  authorize: (user) => canVerifySocialConnection(user),
  run: async ({ input, user, db }) => {
    const result = await verifyManualConnection(db, user, input.connectionId)
    if (result.verifiedNow) await refreshCreatorInBackground(result.userId)
    return result
  },
})

// --- Audience summary --------------------------------------------------------------------------

/**
 * "Continue" on /onboarding/creator/review: store the creator's (possibly edited) summary and
 * topics, record their decision on the AI text (`ai.reviewed`), complete the step and move on.
 */
export const confirmAudienceReview = defineAction({
  name: "onboarding.creator_review",
  input: audienceSummaryFormSchema,
  authorize: (user) => canViewOwnAudience(user),
  run: async ({ input, user, db }) => {
    const nextStep = await withTransaction(async (tx) => {
      try {
        await reviewAudienceSummary(tx, { userId: user.id, form: input, source: "onboarding" })
      } catch (error) {
        if (error instanceof CreatorProfileMissingError) {
          throw new ActionError("Create your creator profile first.")
        }
        throw error
      }
      const result = await completeOnboardingStep(tx, {
        userId: user.id,
        step: "creator.review",
        status: "done",
      })
      return result.nextStep
    }, db)
    await runInBackground("creator_embedding", async () => {
      await refreshCreatorEmbedding(getDb(), user.id)
      await revalidatePublicProfiles(getDb(), user.id)
    })
    redirect(nextStep ?? "/app")
  },
})

/** Save edits to the summary and topics on /app/audience. */
export const updateAudienceSummary = defineAction({
  name: "social.update_summary",
  input: audienceSummaryFormSchema,
  authorize: (user) => canViewOwnAudience(user),
  run: async ({ input, user, db }) => {
    let review
    try {
      review = await reviewAudienceSummary(db, { userId: user.id, form: input, source: "settings" })
    } catch (error) {
      if (error instanceof CreatorProfileMissingError) {
        throw new ActionError("Create your creator profile first.")
      }
      throw error
    }
    if (review.changed) {
      await runInBackground("creator_embedding", async () => {
        await refreshCreatorEmbedding(getDb(), user.id)
        await revalidatePublicProfiles(getDb(), user.id)
      })
    }
    revalidateSocialPages()
    return { changed: review.changed }
  },
})

/**
 * "Regenerate": write a fresh AI summary from the latest data, replacing the creator's edit, and
 * let later syncs keep it current again (clears `audience_summary_edited_at`).
 */
export const regenerateAudienceSummary = defineAction({
  name: "social.regenerate_summary",
  input: z.object({}),
  authorize: (user) => canViewOwnAudience(user),
  run: async ({ user, db }) => {
    const limit = await rateLimit("audience-summary-regenerate", user.id, REGENERATE_RATE_LIMIT)
    if (!limit.success) {
      throw new ActionError("You've regenerated the summary a few times already. Try again later.")
    }
    const { outcome } = await refreshAudienceSummary(db, user.id, {
      force: true,
      actorUserId: user.id,
    })
    switch (outcome) {
      case "no_profile":
        throw new ActionError("Create your creator profile first.")
      case "no_data":
        throw new ActionError(
          "Connect an account (or enter your numbers) first, so there is something to summarise.",
        )
      case "fallback":
        throw new ActionError(
          "We couldn't write a new summary right now. Your current summary is unchanged; please try again later.",
        )
      case "generated":
      case "kept_edited":
        break
    }
    await runInBackground("creator_embedding", async () => {
      await refreshCreatorEmbedding(getDb(), user.id)
      await revalidatePublicProfiles(getDb(), user.id)
    })
    revalidateSocialPages()
    return { outcome }
  },
})

// --- Onboarding: connect step ------------------------------------------------------------------

/** "Continue" on /onboarding/creator/connect once at least one account is connected. */
export const finishConnectStep = defineAction({
  name: "onboarding.creator_connect",
  input: z.object({}),
  // The connect step belongs to the creator path.
  authorize: (user) => canEditCreatorProfile(user),
  run: async ({ user, db }) => {
    const snapshot = await loadOnboardingSnapshot(db, user.id)
    if (!snapshot || snapshot.creatorConnectionCount === 0) {
      throw new ActionError("Connect an account first, or choose “Do this later”.")
    }
    const { nextStep } = await completeOnboardingStep(db, {
      userId: user.id,
      step: "creator.connect",
      status: "done",
    })
    redirect(nextStep ?? "/app")
  },
})
