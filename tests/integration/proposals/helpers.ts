import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, asc, eq } from "drizzle-orm"

import type { AuthUser } from "@/lib/auth/user"
import type { Db } from "@/lib/db/client"
import { events, notifications, users, type UserRole } from "@/lib/db/schema"
import type { ProposalTerms } from "@/lib/proposals/fields"

import { insertBuilder, insertCreator, insertIdea, insertProduct } from "../../helpers/db-fixtures"

/**
 * Shared setup for the proposals, messages and notifications integration tests: onboarded people
 * as the session sees them, open targets, terms, and readers for events and notifications.
 */

export async function makeTempDataDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "proposals-test-"))
}

export async function removeTempDataDir(dir: string): Promise<void> {
  if (dir) await rm(dir, { recursive: true, force: true })
}

const ONBOARDED_AT = new Date("2026-01-01T00:00:00.000Z")

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

async function onboard(db: Db, userId: string, roles?: UserRole[]) {
  const [row] = await db
    .update(users)
    .set({ onboardingCompletedAt: ONBOARDED_AT, ...(roles ? { roles } : {}) })
    .where(eq(users.id, userId))
    .returning()
  if (!row) throw new Error("onboard: no user")
  return row
}

/** A creator with a profile who finished onboarding, plus the session's view of them. */
export async function onboardedCreator(db: Db) {
  const creator = await insertCreator(db)
  const user = await onboard(db, creator.user.id)
  return { ...creator, user, auth: authUserOf(user) }
}

/** A builder with a profile who finished onboarding, plus the session's view of them. */
export async function onboardedBuilder(db: Db) {
  const builder = await insertBuilder(db)
  const user = await onboard(db, builder.user.id)
  return { ...builder, user, auth: authUserOf(user) }
}

/** A test person: their row, their session view, and the profile of their role. */
export type Person = {
  user: typeof users.$inferSelect
  auth: AuthUser
  profile: { id: string; displayName: string }
}

export async function openIdea(db: Db, creator: Person, title = "Budget tracker for students") {
  return insertIdea(db, creator.profile.id, { status: "open", title })
}

export async function seekingProduct(
  db: Db,
  builder: Person,
  overrides: Partial<Parameters<typeof insertProduct>[2]> = {},
) {
  return insertProduct(db, builder.profile.id, { status: "seeking", ...overrides })
}

export function terms(overrides: Partial<ProposalTerms> = {}): ProposalTerms {
  return {
    message: "Loved this idea, here's how I'd build it.",
    scope: "A web app with budgets, categories and CSV import.",
    creatorSplitPct: 60,
    builderSplitPct: 40,
    timelineWeeks: 6,
    ...overrides,
  }
}

export async function eventsOf(db: Db, subjectId: string, type?: string) {
  return db
    .select()
    .from(events)
    .where(
      type
        ? and(eq(events.subjectId, subjectId), eq(events.type, type))
        : eq(events.subjectId, subjectId),
    )
    .orderBy(asc(events.occurredAt))
}

export async function notificationsOf(db: Db, userId: string, type?: string) {
  return db
    .select()
    .from(notifications)
    .where(
      type
        ? and(eq(notifications.userId, userId), eq(notifications.type, type))
        : eq(notifications.userId, userId),
    )
    .orderBy(asc(notifications.createdAt))
}
