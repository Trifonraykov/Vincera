import "server-only"

import { eq } from "drizzle-orm"

import { registerUser } from "@/lib/auth/register"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { users } from "@/lib/db/schema"
import { refreshEmbedding } from "@/lib/embeddings/refresh"
import { completeOnboardingStep } from "@/lib/onboarding/complete-step"
import {
  builderProfileFormSchema,
  creatorProfileFormSchema,
  portfolioItemFormSchema,
} from "@/lib/profiles/fields"
import { addPortfolioItem } from "@/lib/profiles/portfolio"
import { saveBuilderProfile, saveCreatorProfile } from "@/lib/profiles/save"
import { refreshAudienceSummary } from "@/lib/social/derived"
import { addUserRoles } from "@/lib/users/roles"

import { connectSeedAccount, githubSnapshot, seedPayoutsAccount, youtubeSnapshot } from "./accounts"
import {
  SEED_BUILDERS,
  SEED_CREATORS,
  seedBuilderEmail,
  seedCreatorEmail,
  type SeedBuilder,
  type SeedCreator,
} from "./data"
import type { SeedStep } from "./types"

/**
 * Seed step "people" (owner: matching; CLAUDE.md §19.24 "Seed", §19.27): 10 creators with a
 * verified YouTube audience (snapshot, AI summary, size tier) and 10 builders with a GitHub
 * snapshot and a portfolio, all onboarded and payouts-ready, each profile embedded. Every write
 * goes through the app's own functions (sign-up, roles, profile forms, portfolio, the OAuth
 * connection upsert, onboarding steps), so events and checks hold. People whose email exists
 * are skipped.
 */

export async function findUserIdByEmail(database: DbOrTx, email: string): Promise<string | null> {
  const [row] = await database.select({ id: users.id }).from(users).where(eq(users.email, email))
  return row?.id ?? null
}

async function signUp(database: DbOrTx, email: string, name: string, role: "creator" | "builder") {
  const user = await registerUser(database, { email, name }, { method: "email", adminEmails: [] })
  await addUserRoles(database, {
    userId: user.id,
    roles: [role],
    source: "onboarding",
    actorUserId: user.id,
    activeRole: role,
  })
  return user.id
}

async function seedCreator(
  database: DbOrTx,
  persona: SeedCreator,
  index: number,
): Promise<boolean> {
  const email = seedCreatorEmail(index)
  if (await findUserIdByEmail(database, email)) return false
  const userId = await signUp(database, email, persona.name, "creator")
  const { profileId } = await saveCreatorProfile(database, {
    userId,
    source: "onboarding",
    form: creatorProfileFormSchema.parse({
      displayName: persona.name,
      handle: persona.handle,
      niche: persona.niche,
      bio: persona.bio,
      topics: persona.topics.join(", "),
      country: persona.country,
      languages: persona.languages,
    }),
  })
  const channelId = `UCseed${String(index + 1).padStart(2, "0")}${persona.handle.replace(/_/g, "")}`
  await connectSeedAccount(database, {
    userId,
    provider: "youtube",
    accountId: channelId,
    username: persona.handle,
    displayName: persona.name,
    profileUrl: `https://www.youtube.com/@${persona.handle}`,
    snapshot: youtubeSnapshot(persona, channelId),
  })
  // The AI audience summary from the snapshot (fake AI without a key), like a sync writes it.
  await refreshAudienceSummary(database, userId)
  await recordStep(database, { userId, step: "creator.connect", status: "done" })
  await recordStep(database, { userId, step: "creator.review", status: "done" })
  await seedPayoutsAccount(database, {
    userId,
    accountId: `acct_seed_creator_${String(index + 1).padStart(2, "0")}`,
    country: persona.country,
  })
  await recordStep(database, { userId, step: "payouts", status: "done" })
  await refreshEmbedding(database, { type: "creator_profile", id: profileId })
  return true
}

/**
 * Record an onboarding step inside its own transaction: given a transaction, the onboarding code
 * leaves the matching request to the caller (CLAUDE.md §19.30), and the seed computes matches
 * itself in its matches step, once supply exists ("steps never enqueue jobs", §19.27).
 */
async function recordStep(
  database: DbOrTx,
  input: Parameters<typeof completeOnboardingStep>[1],
): Promise<void> {
  await withTransaction((tx) => completeOnboardingStep(tx, input), database)
}

async function seedBuilder(
  database: DbOrTx,
  persona: SeedBuilder,
  index: number,
): Promise<boolean> {
  const email = seedBuilderEmail(index)
  if (await findUserIdByEmail(database, email)) return false
  const userId = await signUp(database, email, persona.name, "builder")
  const { profileId } = await saveBuilderProfile(database, {
    userId,
    source: "onboarding",
    form: builderProfileFormSchema.parse({
      displayName: persona.name,
      handle: persona.handle,
      bio: persona.bio,
      skills: persona.skills.join(", "),
      stack: persona.stack.join(", "),
      availability: persona.availability,
      dealPreference: persona.dealPreference,
    }),
  })
  for (const item of persona.portfolio) {
    await addPortfolioItem(database, {
      userId,
      source: "onboarding",
      form: portfolioItemFormSchema.parse({
        title: item.title,
        url: item.url,
        description: item.description,
        format: item.format,
        isShipped: item.shipped,
      }),
    })
  }
  await connectSeedAccount(database, {
    userId,
    provider: "github",
    accountId: `seed-gh-${String(index + 1).padStart(2, "0")}`,
    username: persona.github.login,
    displayName: persona.name,
    profileUrl: `https://github.com/${persona.github.login}`,
    snapshot: githubSnapshot(persona),
  })
  await recordStep(database, { userId, step: "builder.portfolio", status: "done" })
  await seedPayoutsAccount(database, {
    userId,
    accountId: `acct_seed_builder_${String(index + 1).padStart(2, "0")}`,
    country: "DE",
  })
  await recordStep(database, { userId, step: "payouts", status: "done" })
  await refreshEmbedding(database, { type: "builder_profile", id: profileId })
  return true
}

export const seedPeople: SeedStep = {
  name: "people",
  owner: "matching",
  run: async ({ db }) => {
    let created = 0
    for (const [index, persona] of SEED_CREATORS.entries()) {
      if (await seedCreator(db, persona, index)) created += 1
    }
    for (const [index, persona] of SEED_BUILDERS.entries()) {
      if (await seedBuilder(db, persona, index)) created += 1
    }
    return { created }
  },
}
