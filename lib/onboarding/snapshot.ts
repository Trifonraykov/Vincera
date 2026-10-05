import "server-only"

import { and, eq, inArray, ne, sql } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import {
  builderProfiles,
  creatorProfiles,
  portfolioItems,
  socialConnections,
  stripeAccounts,
  users,
  type SocialProvider,
} from "@/lib/db/schema"
import { payoutsStateOf } from "@/lib/payouts/readiness"
import { CREATOR_SOCIAL_PROVIDERS } from "@/lib/social/types"

import type { OnboardingSnapshot } from "./next-step"
import { parseOnboardingSteps } from "./steps"

/**
 * Load the input of the onboarding step logic (`./next-step.ts`) for one user, in one query.
 * Null when the user does not exist. Pass a transaction to read inside it.
 */
export async function loadOnboardingSnapshot(
  database: DbOrTx,
  userId: string,
): Promise<OnboardingSnapshot | null> {
  // Connections that are not revoked (an expired one still shows the step was done).
  const connectionCount = (providers: SocialProvider[]) =>
    sql<number>`(
      select count(*) from ${socialConnections}
      where ${and(
        eq(socialConnections.userId, users.id),
        inArray(socialConnections.provider, providers),
        ne(socialConnections.status, "revoked"),
      )}
    )`.mapWith(Number)

  const [row] = await database
    .select({
      roles: users.roles,
      onboardingCompletedAt: users.onboardingCompletedAt,
      steps: users.onboardingSteps,
      hasCreatorProfile: sql<boolean>`exists (
        select 1 from ${creatorProfiles} where ${eq(creatorProfiles.userId, users.id)}
      )`.mapWith(Boolean),
      hasBuilderProfile: sql<boolean>`exists (
        select 1 from ${builderProfiles} where ${eq(builderProfiles.userId, users.id)}
      )`.mapWith(Boolean),
      creatorConnectionCount: connectionCount([...CREATOR_SOCIAL_PROVIDERS]),
      githubConnectionCount: connectionCount(["github"]),
      portfolioItemCount: sql<number>`(
        select count(*) from ${portfolioItems}
        inner join ${builderProfiles} on ${eq(builderProfiles.id, portfolioItems.builderProfileId)}
        where ${eq(builderProfiles.userId, users.id)}
      )`.mapWith(Number),
      payoutsEnabled: stripeAccounts.payoutsEnabled,
      transfersCapability: stripeAccounts.transfersCapability,
    })
    .from(users)
    .leftJoin(stripeAccounts, eq(stripeAccounts.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1)

  if (!row) return null
  return {
    roles: row.roles,
    onboardingCompletedAt: row.onboardingCompletedAt,
    steps: parseOnboardingSteps(row.steps),
    hasCreatorProfile: row.hasCreatorProfile,
    hasBuilderProfile: row.hasBuilderProfile,
    creatorConnectionCount: row.creatorConnectionCount,
    githubConnectionCount: row.githubConnectionCount,
    portfolioItemCount: row.portfolioItemCount,
    payouts: payoutsStateOf(
      row.payoutsEnabled === null || row.transfersCapability === null
        ? null
        : { payoutsEnabled: row.payoutsEnabled, transfersCapability: row.transfersCapability },
    ),
  }
}
