import { and, asc, eq } from "drizzle-orm"

import type { AuthUser } from "@/lib/auth/user"
import type { Db } from "@/lib/db/client"
import {
  audienceSnapshots,
  builderProfiles,
  creatorProfiles,
  events,
  matches,
  users,
  type Availability,
  type ProductFormat,
  type SizeTier,
} from "@/lib/db/schema"
import type { CountryShare } from "@/lib/db/schema/types"

import {
  insertBuilder,
  insertCreator,
  insertPortfolioItem,
  insertSocialConnection,
} from "../../helpers/db-fixtures"

/** Shared setup for the matching integration tests (CLAUDE.md §19.27). */

const ONBOARDED = new Date("2026-01-01T00:00:00Z")

/** A 1024-dim vector with weight on the given dimensions (cosine needs no normalisation). */
export function vector(...dims: number[]): number[] {
  const values = Array.from({ length: 1024 }, () => 0)
  for (const dim of dims) values[dim] = (values[dim] ?? 0) + 1
  return values
}

export function authUserOf(row: typeof users.$inferSelect): AuthUser {
  return {
    id: row.id,
    email: row.email ?? "unknown@example.test",
    name: row.name,
    image: null,
    roles: row.roles,
    activeRole: row.activeRole,
    status: row.status,
    onboardingCompletedAt: row.onboardingCompletedAt,
  }
}

async function onboard(db: Db, userId: string) {
  const [user] = await db
    .update(users)
    .set({ onboardingCompletedAt: ONBOARDED })
    .where(eq(users.id, userId))
    .returning()
  if (!user) throw new Error("onboard: no user")
  return user
}

export type CreatorOptions = {
  topics?: string[]
  languages?: string[]
  embedding?: number[] | null
  sizeTier?: SizeTier | null
  /** A verified YouTube connection with this audience (null: no connection). */
  audience?: { followers: number; countries: CountryShare[] } | null
  onboarded?: boolean
}

/** An onboarded creator with a verified YouTube connection (unless told otherwise). */
export async function matchCreator(db: Db, options: CreatorOptions = {}) {
  const created = await insertCreator(db)
  const user = options.onboarded === false ? created.user : await onboard(db, created.user.id)
  const [profile] = await db
    .update(creatorProfiles)
    .set({
      topics: options.topics ?? ["budget cooking", "meal prep"],
      languages: options.languages ?? ["en"],
      embedding: options.embedding === undefined ? vector(1, 2) : options.embedding,
      sizeTier: options.sizeTier === undefined ? "micro" : options.sizeTier,
    })
    .where(eq(creatorProfiles.id, created.profile.id))
    .returning()
  if (!profile) throw new Error("matchCreator: no profile")
  let connection = null
  const audience =
    options.audience === undefined
      ? {
          followers: 42_000,
          countries: [
            { country: "GB", share: 0.6 },
            { country: "US", share: 0.4 },
          ],
        }
      : options.audience
  if (audience) {
    connection = await insertSocialConnection(db, user.id)
    await db.insert(audienceSnapshots).values({
      socialConnectionId: connection.id,
      takenAt: ONBOARDED,
      followers: audience.followers,
      topCountries: audience.countries,
      countriesBasis: "viewers",
      topTopics: [],
      raw: {},
    })
  }
  return { user, profile, connection, auth: authUserOf(user) }
}

export type BuilderOptions = {
  skills?: string[]
  stack?: string[]
  embedding?: number[] | null
  availability?: Availability
  shipped?: ProductFormat[]
  onboarded?: boolean
}

/** An onboarded builder with a shipped portfolio item per `shipped` format. */
export async function matchBuilder(db: Db, options: BuilderOptions = {}) {
  const created = await insertBuilder(db)
  const user = options.onboarded === false ? created.user : await onboard(db, created.user.id)
  const [profile] = await db
    .update(builderProfiles)
    .set({
      skills: options.skills ?? ["meal prep", "react"],
      stack: options.stack ?? ["typescript"],
      embedding: options.embedding === undefined ? vector(1, 2) : options.embedding,
      availability: options.availability ?? "open",
    })
    .where(eq(builderProfiles.id, created.profile.id))
    .returning()
  if (!profile) throw new Error("matchBuilder: no profile")
  for (const format of options.shipped ?? []) {
    await insertPortfolioItem(db, profile.id, { format, isShipped: true })
  }
  return { user, profile, auth: authUserOf(user) }
}

/** Give an existing user a builder profile too (both roles), sharing their handle. */
export async function addBuilderProfile(db: Db, userId: string, handle: string) {
  await db
    .update(users)
    .set({ roles: ["creator", "builder"] })
    .where(eq(users.id, userId))
  const [profile] = await db
    .insert(builderProfiles)
    .values({ userId, handle, displayName: `Builder ${handle}`, embedding: vector(1, 2) })
    .returning()
  if (!profile) throw new Error("addBuilderProfile: no profile")
  return profile
}

/** The subject's rows, best first. */
export async function matchRows(db: Db, subjectUserId: string) {
  return db
    .select()
    .from(matches)
    .where(eq(matches.subjectUserId, subjectUserId))
    .orderBy(asc(matches.staleAt), asc(matches.targetType), asc(matches.targetId))
}

export async function currentRows(db: Db, subjectUserId: string) {
  return (await matchRows(db, subjectUserId)).filter((row) => row.staleAt === null)
}

export async function eventsOf(db: Db, type: string, subjectId?: string) {
  return db
    .select()
    .from(events)
    .where(
      subjectId
        ? and(eq(events.type, type), eq(events.subjectId, subjectId))
        : eq(events.type, type),
    )
    .orderBy(asc(events.occurredAt), asc(events.id))
}
