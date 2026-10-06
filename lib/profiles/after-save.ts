import "server-only"

import { revalidatePath } from "next/cache"

import type { Db } from "@/lib/db/client"
import { requestEmbeddingRefreshAfterCommit } from "@/lib/embeddings/request"
import { requestMatchingForPerson } from "@/lib/matching/request"
import { publicProfilePaths, revalidatePublicProfiles } from "@/lib/social/revalidate"

import type { ProfileSaveResult } from "./save"

/**
 * What follows a committed profile save, for every client that saves a profile (the web's server
 * actions in ./actions.ts and the mobile API, CLAUDE.md §19.44): the embedding refresh (§8
 * `semantic`, CLAUDE.md §19.25), a direct matching request when only candidacy changed, and the
 * revalidation of the public profile and app pages. Moved out of ./actions.ts unchanged, because a
 * "use server" module may only export server actions.
 */

/** Columns whose change alters the embedding text (lib/social/derived.ts, ./embedding.ts). */
const CREATOR_EMBEDDED = new Set(["niche", "bio", "topics", "languages", "country"])
const BUILDER_EMBEDDED = new Set(["bio", "skills", "stack"])
/**
 * Fields that change who may be matched without changing the embedded text: a builder's
 * availability decides whether creators see them at all (§8 "availability ≠ closed"), so a change
 * asks matching directly instead of waiting for the nightly run (CLAUDE.md §19.30).
 */
const BUILDER_CANDIDACY = new Set(["availability"])

const PROFILE_PAGES = ["/app/settings/profile", "/app/audience", "/app"] as const

function revalidatePaths(paths: Iterable<string>): void {
  for (const path of paths) revalidatePath(path)
}

async function afterProfileSave(
  db: Db,
  userId: string,
  result: ProfileSaveResult,
  embedded: ReadonlySet<string>,
  type: "creator_profile" | "builder_profile",
  candidacy: ReadonlySet<string> = new Set(),
): Promise<void> {
  const reembed = result.created || result.fields.some((field) => embedded.has(field))
  if (reembed) {
    await requestEmbeddingRefreshAfterCommit({ type, id: result.profileId })
  } else if (result.fields.some((field) => candidacy.has(field))) {
    // The embedding job would ask matching anyway; without a re-embed, ask it here.
    await requestMatchingForPerson(userId, [type === "creator_profile" ? "creator" : "builder"])
  }
  if (result.created || result.fields.length > 0) {
    await revalidatePublicProfiles(db, userId)
    if (result.previousHandle) revalidatePaths(publicProfilePaths(result.previousHandle))
    revalidatePaths(PROFILE_PAGES)
  }
}

export function afterCreatorProfileSave(
  db: Db,
  userId: string,
  result: ProfileSaveResult,
): Promise<void> {
  return afterProfileSave(db, userId, result, CREATOR_EMBEDDED, "creator_profile")
}

export function afterBuilderProfileSave(
  db: Db,
  userId: string,
  result: ProfileSaveResult,
): Promise<void> {
  return afterProfileSave(
    db,
    userId,
    result,
    BUILDER_EMBEDDED,
    "builder_profile",
    BUILDER_CANDIDACY,
  )
}
