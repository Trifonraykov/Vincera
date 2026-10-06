import "server-only"

import { and, eq, inArray } from "drizzle-orm"

import type { AuthzUser } from "@/lib/auth/authz"
import { registerUser } from "@/lib/auth/register"
import type { DbOrTx } from "@/lib/db/client"
import { collabMembers, collabs, launches, users } from "@/lib/db/schema"
import { launchFormSchema } from "@/lib/launches/fields"
import { adminApproveLaunch, approveLaunch, createLaunch, saveLaunch } from "@/lib/launches/service"

import type { SeedStep } from "./types"

/**
 * `launches` (Phase 4, owner: launch; CLAUDE.md §19.31 "Seed", §19.32): collab 03 (creator 03 ×
 * builder 03, signed, `building`) gets a launch taken live through the app's own functions: the
 * creator starts and fills it in, both members approve, and the seeded admin
 * (`seed-admin@example.com`, made here with the admin role) approves it in review. Going live
 * creates the creator's default tracked link and moves the collab to `live` (§15: a live launch).
 *
 * Idempotent: a collab that already has a launch is left alone; missing people or a collab that
 * is not in `building` skip the step.
 */

export const SEED_ADMIN_EMAIL = "seed-admin@example.com"

const seedEmail = (role: "creator" | "builder", pair: number) =>
  `seed-${role}-${String(pair).padStart(2, "0")}@example.com`

async function loadUser(database: DbOrTx, email: string): Promise<AuthzUser | null> {
  const [row] = await database
    .select({
      id: users.id,
      roles: users.roles,
      status: users.status,
      onboardingCompletedAt: users.onboardingCompletedAt,
    })
    .from(users)
    .where(eq(users.email, email))
  return row ?? null
}

async function seedAdmin(database: DbOrTx): Promise<AuthzUser> {
  const existing = await loadUser(database, SEED_ADMIN_EMAIL)
  if (existing) return existing
  const admin = await registerUser(
    database,
    { email: SEED_ADMIN_EMAIL, name: "Seed Admin" },
    { method: "email", adminEmails: [SEED_ADMIN_EMAIL] },
  )
  return {
    id: admin.id,
    roles: admin.roles,
    status: admin.status,
    onboardingCompletedAt: admin.onboardingCompletedAt,
  }
}

/** The collab both people are members of, with its stage. */
async function sharedCollab(database: DbOrTx, a: string, b: string) {
  const rows = await database
    .select({
      collabId: collabMembers.collabId,
      userId: collabMembers.userId,
      stage: collabs.stage,
    })
    .from(collabMembers)
    .innerJoin(collabs, eq(collabs.id, collabMembers.collabId))
    .where(inArray(collabMembers.userId, [a, b]))
  const members = new Map<string, { users: Set<string>; stage: string }>()
  for (const row of rows) {
    const entry = members.get(row.collabId) ?? { users: new Set<string>(), stage: row.stage }
    entry.users.add(row.userId)
    members.set(row.collabId, entry)
  }
  for (const [collabId, entry] of members) {
    if (entry.users.size === 2) return { collabId, stage: entry.stage }
  }
  return null
}

const FIELDS = launchFormSchema.parse({
  title: "Printable checklist planner",
  tagline: "Turn the channel's checklists into a planner you can print and share",
  descriptionMd: [
    "A small web tool that turns the checklists from the channel into a **printable weekly planner**.",
    "",
    "- Pick the checklists you use",
    "- Print or save as PDF",
    "- Share a read-only link with your family",
  ].join("\n"),
  price: "12",
  slug: "printable-checklist-planner",
  deliveryType: "url",
  deliveryUrl: "https://planner.example.com/welcome",
  instructions: "",
})

export const seedLaunches: SeedStep = {
  name: "launches",
  owner: "launch",
  run: async ({ db }) => {
    const creator = await loadUser(db, seedEmail("creator", 3))
    const builder = await loadUser(db, seedEmail("builder", 3))
    if (!creator || !builder) return { skipped: "pair 3: people missing" }
    const collab = await sharedCollab(db, creator.id, builder.id)
    if (!collab) return { skipped: "pair 3: no collab" }
    const [existing] = await db
      .select({ id: launches.id })
      .from(launches)
      .where(and(eq(launches.collabId, collab.collabId)))
    if (existing) return { created: 0 }
    if (collab.stage !== "building") return { skipped: `pair 3: collab is ${collab.stage}` }

    const admin = await seedAdmin(db)
    const { launchId } = await createLaunch(db, creator, { collabId: collab.collabId })
    const [taken] = await db
      .select({ id: launches.id })
      .from(launches)
      .where(eq(launches.slug, FIELDS.slug))
    await saveLaunch(db, creator, {
      launchId,
      fields: taken ? { ...FIELDS, slug: `${FIELDS.slug}-seed` } : FIELDS,
    })
    await approveLaunch(db, creator, { launchId }, { autoApprove: false })
    await approveLaunch(db, builder, { launchId }, { autoApprove: false })
    await adminApproveLaunch(db, admin, { launchId })
    return { created: 1 }
  },
}
