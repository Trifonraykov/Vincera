import "server-only"

import { explainMatches } from "@/lib/matching/explain"
import { hasAnyMatches } from "@/lib/matching/queries"
import { recomputeMatchesForUser } from "@/lib/matching/recompute"

import { SEED_BUILDERS, SEED_CREATORS, seedBuilderEmail, seedCreatorEmail } from "./data"
import { findUserIdByEmail } from "./people"
import type { SeedStep } from "./types"

/**
 * Seed step "matches" (owner: matching): the real matching recompute for every seeded person
 * (candidates, features, scores, the top 30, `match.computed`), then their explanations (fake AI
 * without a key), so seeded users see ranked matches with explanations at once. People who
 * already have matches are skipped (the nightly job keeps them fresh).
 */
export const seedMatches: SeedStep = {
  name: "matches",
  owner: "matching",
  run: async ({ db }) => {
    const emails = [
      ...SEED_CREATORS.map((_, index) => seedCreatorEmail(index)),
      ...SEED_BUILDERS.map((_, index) => seedBuilderEmail(index)),
    ]
    let created = 0
    for (const email of emails) {
      const userId = await findUserIdByEmail(db, email)
      if (!userId || (await hasAnyMatches(db, userId))) continue
      const result = await recomputeMatchesForUser(db, userId, { reason: "manual" })
      await explainMatches(db, result.pending)
      created += result.roles.reduce((sum, role) => sum + role.stored, 0)
    }
    return { created }
  },
}
