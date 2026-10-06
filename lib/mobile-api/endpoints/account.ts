import "server-only"

import {
  canEditBuilderProfile,
  canEditCreatorProfile,
  canManageOwnAccount,
  canViewOwnEarnings,
  hasRole,
} from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { loadEarningsOverview } from "@/lib/payouts/earnings"
import { afterBuilderProfileSave, afterCreatorProfileSave } from "@/lib/profiles/after-save"
import { builderProfileFormSchema, creatorProfileFormSchema } from "@/lib/profiles/fields"
import { loadBuilderProfileForm, loadCreatorProfileForm } from "@/lib/profiles/queries"
import { saveBuilderProfile, saveCreatorProfile } from "@/lib/profiles/save"
import { loadAudienceOverview } from "@/lib/social/audience"
import { canViewOwnAudience } from "@/lib/social/authz"

import { forbidden } from "../errors"
import { endpoint, parseForm, type Endpoint } from "../router"
import {
  audienceOutput,
  builderProfileInput,
  creatorProfileInput,
  earningsOutput,
  profileOutput,
  profileSavedOutput,
} from "../schemas"

/**
 * The person's own pages: audience (§12 `/app/audience`, creators), earnings (`/app/earnings`)
 * and the profile forms (Settings → Profile), with the web's loaders, form schemas and save
 * services (CLAUDE.md §19.14, §19.15, §19.35).
 */

export const accountEndpoints: Endpoint[] = [
  endpoint({
    method: "GET",
    path: "/audience",
    auth: "onboarded",
    output: audienceOutput,
    run: async ({ db, user }) => {
      if (!hasRole(user, "creator")) {
        return {
          isCreator: false,
          profile: null,
          tier: { tier: null, verified: false },
          connections: [],
          syncPending: false,
          summaryPending: false,
          lastSyncedAt: null,
        }
      }
      if (!canViewOwnAudience(user)) throw forbidden()
      const overview = await loadAudienceOverview(db, user.id)
      return { isCreator: true, ...overview }
    },
  }),
  endpoint({
    method: "GET",
    path: "/earnings",
    auth: "onboarded",
    output: earningsOutput,
    run: async ({ db, user }) => {
      if (!canViewOwnEarnings(user)) throw forbidden()
      return loadEarningsOverview(db, { userId: user.id, at: now() })
    },
  }),
  endpoint({
    method: "GET",
    path: "/profile",
    auth: "onboarded",
    output: profileOutput,
    run: async ({ db, user }) => {
      if (!canManageOwnAccount(user)) throw forbidden()
      const [creator, builder] = await Promise.all([
        hasRole(user, "creator") ? loadCreatorProfileForm(db, user.id) : null,
        hasRole(user, "builder") ? loadBuilderProfileForm(db, user.id) : null,
      ])
      return {
        creator: creator
          ? {
              ...creator,
              niche: creator.niche ?? "",
              bio: creator.bio ?? "",
              country: creator.country ?? "",
            }
          : null,
        builder: builder ? { ...builder, bio: builder.bio ?? "" } : null,
        canEditCreator: canEditCreatorProfile(user),
        canEditBuilder: canEditBuilderProfile(user),
      }
    },
  }),
  endpoint({
    method: "PUT",
    path: "/profile/creator",
    auth: "onboarded",
    input: creatorProfileInput,
    output: profileSavedOutput,
    run: async ({ db, user, input }) => {
      if (!canEditCreatorProfile(user)) throw forbidden()
      const form = parseForm(creatorProfileFormSchema, input)
      const result = await saveCreatorProfile(db, { userId: user.id, form, source: "settings" })
      await afterCreatorProfileSave(db, user.id, result)
      return { created: result.created, changed: result.fields.length > 0, handle: form.handle }
    },
  }),
  endpoint({
    method: "PUT",
    path: "/profile/builder",
    auth: "onboarded",
    input: builderProfileInput,
    output: profileSavedOutput,
    run: async ({ db, user, input }) => {
      if (!canEditBuilderProfile(user)) throw forbidden()
      const form = parseForm(builderProfileFormSchema, input)
      const result = await saveBuilderProfile(db, { userId: user.id, form, source: "settings" })
      await afterBuilderProfileSave(db, user.id, result)
      return { created: result.created, changed: result.fields.length > 0, handle: form.handle }
    },
  }),
]
