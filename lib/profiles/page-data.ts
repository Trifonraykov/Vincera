import "server-only"

import type { AuthUser } from "@/lib/auth/user"
import type { DbOrTx } from "@/lib/db/client"
import { safeUrl } from "@/lib/social/metrics"

import type { BuilderProfileForm, CreatorProfileForm } from "./fields"
import { suggestHandle } from "./handles"
import { portfolioImagePath } from "./image-policy"
import { listPortfolioItems } from "./portfolio"
import { loadBuilderProfileForm, loadCreatorProfileForm } from "./queries"

/**
 * What the profile pages (onboarding steps, Settings → Profile) render: the saved profile, or
 * sensible defaults for a new one. A new profile starts from the user's other profile (same name,
 * same handle, so one handle can serve both public pages) or from the account name.
 */

/** The form's fields as the page prefills them (not the action-only image fields). */
type FormDefaults<T> = { [K in keyof T]: T[K] extends readonly string[] ? readonly string[] : T[K] }

export type ProfilePageData<Form> = {
  exists: boolean
  defaults: FormDefaults<Form>
  /** Shown under the handle when the other profile already uses a handle. */
  sharedHandleNote: string | undefined
}

const SHARED_HANDLE_NOTE =
  "Keep the handle of your other profile to use one handle for both, or pick a new one."

export async function creatorProfilePageData(
  database: DbOrTx,
  user: Pick<AuthUser, "id" | "name" | "email">,
): Promise<ProfilePageData<CreatorProfileForm>> {
  const profile = await loadCreatorProfileForm(database, user.id)
  if (profile) {
    return {
      exists: true,
      defaults: {
        displayName: profile.displayName,
        handle: profile.handle,
        niche: profile.niche,
        bio: profile.bio,
        topics: profile.topics,
        country: profile.country as CreatorProfileForm["country"],
        languages: profile.languages,
      },
      sharedHandleNote: undefined,
    }
  }
  const other = await loadBuilderProfileForm(database, user.id)
  return {
    exists: false,
    defaults: {
      displayName: other?.displayName ?? user.name ?? "",
      handle: other?.handle ?? (await suggestHandle(database, user)),
      niche: null,
      bio: other?.bio ?? null,
      topics: [],
      country: null,
      languages: [],
    },
    sharedHandleNote: other ? SHARED_HANDLE_NOTE : undefined,
  }
}

export async function builderProfilePageData(
  database: DbOrTx,
  user: Pick<AuthUser, "id" | "name" | "email">,
): Promise<ProfilePageData<BuilderProfileForm>> {
  const profile = await loadBuilderProfileForm(database, user.id)
  if (profile) {
    return {
      exists: true,
      defaults: {
        displayName: profile.displayName,
        handle: profile.handle,
        bio: profile.bio,
        skills: profile.skills,
        stack: profile.stack,
        availability: profile.availability,
        dealPreference: profile.dealPreference,
      },
      sharedHandleNote: undefined,
    }
  }
  const other = await loadCreatorProfileForm(database, user.id)
  return {
    exists: false,
    defaults: {
      displayName: other?.displayName ?? user.name ?? "",
      handle: other?.handle ?? (await suggestHandle(database, user)),
      bio: other?.bio ?? null,
      skills: [],
      stack: [],
      availability: "open",
      dealPreference: "either",
    },
    sharedHandleNote: other ? SHARED_HANDLE_NOTE : undefined,
  }
}

/** The builder's portfolio items as the portfolio list shows them. */
export async function portfolioPageItems(database: DbOrTx, userId: string) {
  const items = await listPortfolioItems(database, userId)
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    // Stored links are already http(s) only (./fields.ts); checked again before reaching an href.
    url: safeUrl(item.url),
    description: item.description,
    format: item.format,
    isShipped: item.isShipped,
    imageSrc: portfolioImagePath(item.id, item.imageUrl),
  }))
}
