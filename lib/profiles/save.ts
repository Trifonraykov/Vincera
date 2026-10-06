import "server-only"

import { eq } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { now } from "@/lib/clock"
import { isTransaction, withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { getPgError, PG_ERROR } from "@/lib/db/errors"
import { builderProfiles, creatorProfiles, users } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import {
  completeOnboardingStep,
  requestMatchingAfterOnboarding,
} from "@/lib/onboarding/complete-step"

import type { BuilderProfileForm, CreatorProfileForm, ProfileFormSource } from "./fields"
import { claimHandle, HandleTakenError, releaseUnusedHandle } from "./handles"

/**
 * Creating and editing creator and builder profiles (§5, §12 `/onboarding/<role>/profile` and
 * `/app/settings/profile`). One transaction per save: claim the handle, insert or update the
 * profile, free a handle the user no longer uses, emit `<role>_profile.created` / `.updated`
 * (changed column names only, never values, §11), and record the onboarding profile step.
 *
 * Embeddings and public-profile revalidation happen after the commit, in the server action.
 *
 * Concurrency: each save first locks the user's row, so two saves of one user (a double submit,
 * two tabs) run one after the other and the second updates what the first created. Two users
 * claiming one handle are settled by `claimHandle` (the loser gets `HandleTakenError`). Any other
 * unique violation becomes a plain-language error instead of a generic failure.
 */

export type ProfileSaveResult = {
  profileId: string
  created: boolean
  /** Changed columns (snake_case), empty when nothing changed. */
  fields: string[]
  /** The handle before a rename, so the caller can revalidate its old public URL. */
  previousHandle: string | null
  /** Where onboarding continues (null when the path is complete). */
  nextStep: string | null
}

type SaveInput<Form> = { userId: string; form: Form; source: ProfileFormSource }

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Column names whose value differs (lists compared in order). */
function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  columns: Record<string, string>,
): string[] {
  return Object.entries(columns)
    .filter(([key]) => {
      const a = before[key]
      const b = after[key]
      if (Array.isArray(a) && Array.isArray(b)) return !sameList(a, b)
      return (a ?? null) !== (b ?? null)
    })
    .map(([, column]) => column)
}

/** Lock the user's row: saves of one user's profiles are serialised (see the header). */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update")
}

/** Unique violations a concurrent save can still cause, as messages people can act on. */
async function withPlainUniqueErrors<T>(save: () => Promise<T>): Promise<T> {
  try {
    return await save()
  } catch (error) {
    const pg = getPgError(error)
    if (pg?.code !== PG_ERROR.uniqueViolation) throw error
    if (pg.constraint === "handles_pkey" || pg.constraint?.endsWith("_handle_unique")) {
      throw new HandleTakenError()
    }
    throw new ActionError(
      "Your profile changed while you were saving. Refresh the page and try again.",
    )
  }
}

const CREATOR_COLUMNS = {
  displayName: "display_name",
  handle: "handle",
  niche: "niche",
  bio: "bio",
  topics: "topics",
  country: "country",
  languages: "languages",
} as const satisfies Record<keyof CreatorProfileForm, string>

const BUILDER_COLUMNS = {
  displayName: "display_name",
  handle: "handle",
  bio: "bio",
  skills: "skills",
  stack: "stack",
  availability: "availability",
  dealPreference: "deal_preference",
} as const satisfies Record<keyof BuilderProfileForm, string>

/** Insert or update the user's creator profile from the profile form. */
export async function saveCreatorProfile(
  database: DbOrTx,
  input: SaveInput<CreatorProfileForm>,
): Promise<ProfileSaveResult> {
  const { userId, form, source } = input
  const saved = await withPlainUniqueErrors(() =>
    withTransaction(async (tx) => {
      await lockUser(tx, userId)
      const [existing] = await tx
        .select()
        .from(creatorProfiles)
        .where(eq(creatorProfiles.userId, userId))
        .for("update")
      await claimHandle(tx, userId, form.handle)
      const values = {
        displayName: form.displayName,
        handle: form.handle,
        niche: form.niche,
        bio: form.bio,
        topics: form.topics,
        country: form.country,
        languages: form.languages,
      }

      let result: Omit<ProfileSaveResult, "nextStep">
      if (!existing) {
        const [profile] = await tx
          .insert(creatorProfiles)
          .values({ userId, ...values })
          .returning({ id: creatorProfiles.id })
        if (!profile) throw new Error("saveCreatorProfile: no row returned")
        await track(
          "creator_profile.created",
          {
            actorUserId: userId,
            subjectType: "creator_profile",
            subjectId: profile.id,
            properties: {
              country: form.country,
              topic_count: form.topics.length,
              language_count: form.languages.length,
            },
          },
          tx,
        )
        result = { profileId: profile.id, created: true, fields: [], previousHandle: null }
      } else {
        const fields = changedFields(existing, values, CREATOR_COLUMNS)
        if (fields.length > 0) {
          // Once a summary exists, topics edited here are the creator's: later syncs keep them
          // (and the summary) like edits on the review page (§19.14). Before that they only seed the
          // first summary, which may refine them (CLAUDE.md §19.17).
          const pinTopics = fields.includes("topics") && existing.audienceSummary !== null
          await tx
            .update(creatorProfiles)
            .set(pinTopics ? { ...values, audienceSummaryEditedAt: now() } : values)
            .where(eq(creatorProfiles.id, existing.id))
          await track(
            "creator_profile.updated",
            {
              actorUserId: userId,
              subjectType: "creator_profile",
              subjectId: existing.id,
              properties: { fields, source },
            },
            tx,
          )
        }
        const renamed = existing.handle !== form.handle
        if (renamed) await releaseUnusedHandle(tx, userId, existing.handle)
        result = {
          profileId: existing.id,
          created: false,
          fields,
          previousHandle: renamed ? existing.handle : null,
        }
      }

      const advance = await completeOnboardingStep(tx, {
        userId,
        step: "creator.profile",
        status: "done",
      })
      return { ...result, nextStep: advance.nextStep, advance }
    }, database),
  )
  const { advance, ...rest } = saved
  // Saving the profile can finish onboarding (a role added later): matching needs to know.
  if (!isTransaction(database)) await requestMatchingAfterOnboarding(userId, advance)
  return rest
}

/** Insert or update the user's builder profile from the profile form. */
export async function saveBuilderProfile(
  database: DbOrTx,
  input: SaveInput<BuilderProfileForm>,
): Promise<ProfileSaveResult> {
  const { userId, form, source } = input
  const saved = await withPlainUniqueErrors(() =>
    withTransaction(async (tx) => {
      await lockUser(tx, userId)
      const [existing] = await tx
        .select()
        .from(builderProfiles)
        .where(eq(builderProfiles.userId, userId))
        .for("update")
      await claimHandle(tx, userId, form.handle)
      const values = {
        displayName: form.displayName,
        handle: form.handle,
        bio: form.bio,
        skills: form.skills,
        stack: form.stack,
        availability: form.availability,
        dealPreference: form.dealPreference,
      }

      let result: Omit<ProfileSaveResult, "nextStep">
      if (!existing) {
        const [profile] = await tx
          .insert(builderProfiles)
          .values({ userId, ...values })
          .returning({ id: builderProfiles.id })
        if (!profile) throw new Error("saveBuilderProfile: no row returned")
        await track(
          "builder_profile.created",
          {
            actorUserId: userId,
            subjectType: "builder_profile",
            subjectId: profile.id,
            properties: {
              skill_count: form.skills.length,
              stack_count: form.stack.length,
              availability: form.availability,
              deal_preference: form.dealPreference,
            },
          },
          tx,
        )
        result = { profileId: profile.id, created: true, fields: [], previousHandle: null }
      } else {
        const fields = changedFields(existing, values, BUILDER_COLUMNS)
        if (fields.length > 0) {
          await tx.update(builderProfiles).set(values).where(eq(builderProfiles.id, existing.id))
          await track(
            "builder_profile.updated",
            {
              actorUserId: userId,
              subjectType: "builder_profile",
              subjectId: existing.id,
              properties: { fields, source },
            },
            tx,
          )
        }
        const renamed = existing.handle !== form.handle
        if (renamed) await releaseUnusedHandle(tx, userId, existing.handle)
        result = {
          profileId: existing.id,
          created: false,
          fields,
          previousHandle: renamed ? existing.handle : null,
        }
      }

      const advance = await completeOnboardingStep(tx, {
        userId,
        step: "builder.profile",
        status: "done",
      })
      return { ...result, nextStep: advance.nextStep, advance }
    }, database),
  )
  const { advance, ...rest } = saved
  // Saving the profile can finish onboarding (a role added later): matching needs to know.
  if (!isTransaction(database)) await requestMatchingAfterOnboarding(userId, advance)
  return rest
}
