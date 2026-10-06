import { and, asc, eq } from "drizzle-orm"

import type { AuthUser } from "@/lib/auth/user"
import type { Db } from "@/lib/db/client"
import { collabs, events, launches, notifications, users } from "@/lib/db/schema"
import { launchFormSchema, type LaunchFields } from "@/lib/launches/fields"

import { insertCollab, insertUser } from "../../helpers/db-fixtures"
import { authUserOf } from "../proposals/helpers"

/**
 * Shared setup for the launch integration tests (CLAUDE.md §19.32): a signed collab in `building`
 * (fixture rows: the agreement flow has its own tests), the people as the session sees them, an
 * admin, complete launch fields, and readers.
 */

export { authUserOf }

export async function buildingCollab(db: Db, stage: "building" | "agreement" = "building") {
  const { collab, creator, builder, idea } = await insertCollab(db, { stage })
  return {
    collab,
    idea,
    creator: { ...creator, auth: authUserOf(creator.user) },
    builder: { ...builder, auth: authUserOf(builder.user) },
  }
}

export async function adminUser(db: Db): Promise<AuthUser> {
  const user = await insertUser(db, { roles: ["admin"] })
  return authUserOf(user)
}

export async function strangerUser(db: Db): Promise<AuthUser> {
  return authUserOf(await insertUser(db, { roles: ["creator"], activeRole: "creator" }))
}

/** Complete fields: a URL delivery and a price, so the launch can be approved. */
export function completeFields(overrides: Record<string, unknown> = {}): LaunchFields {
  return launchFormSchema.parse({
    title: "Meal planner",
    tagline: "Plan a week of meals in five minutes",
    descriptionMd: "A **weekly plan** and a shopping list.",
    price: "19",
    slug: `meal-planner-${Math.random().toString(36).slice(2, 8)}`,
    deliveryType: "url",
    deliveryUrl: "https://app.example.com/welcome",
    instructions: "",
    ...overrides,
  })
}

export async function launchRow(db: Db, id: string) {
  const [row] = await db.select().from(launches).where(eq(launches.id, id))
  if (!row) throw new Error("no launch")
  return row
}

export async function collabStage(db: Db, id: string) {
  const [row] = await db.select({ stage: collabs.stage }).from(collabs).where(eq(collabs.id, id))
  return row?.stage
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
    .orderBy(asc(events.occurredAt), asc(events.id))
}

export async function notificationsOf(db: Db, userId: string, type: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, type)))
}

export async function setStatus(db: Db, userId: string, status: "active" | "suspended") {
  await db.update(users).set({ status }).where(eq(users.id, userId))
}
