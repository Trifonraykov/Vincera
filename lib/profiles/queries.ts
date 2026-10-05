import "server-only"

import { eq } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { builderProfiles, creatorProfiles } from "@/lib/db/schema"

/**
 * The user's own profiles, as the profile forms edit them (onboarding steps and Settings →
 * Profile). Only the form's fields plus ids; never another user's data.
 */

export type CreatorProfileFormValues = {
  id: string
  displayName: string
  handle: string
  niche: string | null
  bio: string | null
  country: string | null
  languages: string[]
}

export type BuilderProfileFormValues = {
  id: string
  displayName: string
  handle: string
  bio: string | null
  skills: string[]
  stack: string[]
  availability: (typeof builderProfiles.$inferSelect)["availability"]
  dealPreference: (typeof builderProfiles.$inferSelect)["dealPreference"]
}

export async function loadCreatorProfileForm(
  database: DbOrTx,
  userId: string,
): Promise<CreatorProfileFormValues | null> {
  const [row] = await database
    .select({
      id: creatorProfiles.id,
      displayName: creatorProfiles.displayName,
      handle: creatorProfiles.handle,
      niche: creatorProfiles.niche,
      bio: creatorProfiles.bio,
      country: creatorProfiles.country,
      languages: creatorProfiles.languages,
    })
    .from(creatorProfiles)
    .where(eq(creatorProfiles.userId, userId))
    .limit(1)
  return row ?? null
}

export async function loadBuilderProfileForm(
  database: DbOrTx,
  userId: string,
): Promise<BuilderProfileFormValues | null> {
  const [row] = await database
    .select({
      id: builderProfiles.id,
      displayName: builderProfiles.displayName,
      handle: builderProfiles.handle,
      bio: builderProfiles.bio,
      skills: builderProfiles.skills,
      stack: builderProfiles.stack,
      availability: builderProfiles.availability,
      dealPreference: builderProfiles.dealPreference,
    })
    .from(builderProfiles)
    .where(eq(builderProfiles.userId, userId))
    .limit(1)
  return row ?? null
}
