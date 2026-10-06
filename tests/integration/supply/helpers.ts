import { and, asc, eq } from "drizzle-orm"
import { vi } from "vitest"

import { jobsFor } from "@/inngest/functions"
import type { AuthUser } from "@/lib/auth/user"
import type { Db } from "@/lib/db/client"
import { events, users } from "@/lib/db/schema"

import { insertBuilder, insertCreator, insertUser } from "../../helpers/db-fixtures"

/** Shared setup for the supply integration tests (ideas, products, embeddings; §19.25). */

export function authUserOf(
  row: typeof users.$inferSelect,
  overrides: Partial<AuthUser> = {},
): AuthUser {
  return {
    id: row.id,
    email: row.email ?? "unknown@example.test",
    name: row.name,
    image: null,
    roles: row.roles,
    activeRole: row.activeRole,
    status: row.status,
    onboardingCompletedAt: row.onboardingCompletedAt,
    ...overrides,
  }
}

/** A creator (user + profile) as the session sees them. */
export async function newCreator(db: Db) {
  const creator = await insertCreator(db)
  return { ...creator, auth: authUserOf(creator.user) }
}

/** A builder (user + profile) as the session sees them. */
export async function newBuilder(db: Db) {
  const builder = await insertBuilder(db)
  return { ...builder, auth: authUserOf(builder.user) }
}

/** A user with the role but no profile yet (left onboarding midway). */
export async function newUserWithoutProfile(db: Db, role: "creator" | "builder") {
  const user = await insertUser(db, { roles: [role], activeRole: role })
  return { user, auth: authUserOf(user) }
}

export async function eventsOf(db: Db, subjectId: string, type?: string) {
  const rows = await db
    .select()
    .from(events)
    .where(
      type
        ? and(eq(events.subjectId, subjectId), eq(events.type, type))
        : eq(events.subjectId, subjectId),
    )
    .orderBy(asc(events.occurredAt), asc(events.id))
  return rows
}

export async function redirectTarget(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) {
      return digest.split(";")[2] ?? ""
    }
    throw error
  }
  throw new Error("expected a redirect")
}

export function formData(values: Record<string, string | string[]>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item)
  }
  return data
}

/**
 * Matching's jobs, stubbed: the embeddings job asks for them, and these tests check that it does,
 * not what matching then computes (matching has its own tests).
 */
export function stubMatchingJobs() {
  const recompute = jobsFor("matching/recompute.requested")
  const rescore = jobsFor("matching/target-changed.requested")
  return {
    recompute: recompute.map((job) => vi.spyOn(job, "runInline").mockResolvedValue({})),
    rescore: rescore.map((job) => vi.spyOn(job, "runInline").mockResolvedValue({})),
  }
}
