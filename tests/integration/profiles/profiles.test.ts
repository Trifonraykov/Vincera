import { and, asc, eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import {
  builderProfiles,
  creatorProfiles,
  events,
  handles,
  notificationPrefs,
  portfolioItems,
  sessions,
  users,
} from "@/lib/db/schema"
import { loadNotificationPrefs, saveNotificationPrefs } from "@/lib/notifications/prefs"
import { builderProfileEmbeddingText, refreshBuilderEmbedding } from "@/lib/profiles/embedding"
import type { BuilderProfileForm, CreatorProfileForm } from "@/lib/profiles/fields"
import {
  claimHandle,
  HandleTakenError,
  releaseUnusedHandle,
  suggestHandle,
} from "@/lib/profiles/handles"
import { creatorProfilePageData, builderProfilePageData } from "@/lib/profiles/page-data"
import {
  addPortfolioItem,
  BuilderProfileMissingError,
  deletePortfolioItem,
  findPortfolioItemOwner,
  listPortfolioItems,
  updatePortfolioItem,
} from "@/lib/profiles/portfolio"
import { saveBuilderProfile, saveCreatorProfile } from "@/lib/profiles/save"
import { countSessions, deleteAllSessions, updateAccountName } from "@/lib/users/account"

import { setupTestDatabase } from "../../helpers/db"
import { insertSocialConnection, insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"

/**
 * Profiles (§5, §12 onboarding profile steps and Settings → Profile, §16 Phase 1): handles,
 * creator and builder profiles with their events and onboarding step, portfolio items, the
 * builder embedding, the server actions (authorization, redirects, field errors), the account
 * settings and notification preferences.
 */

const mocks = vi.hoisted(() => ({
  user: null as AuthUser | null,
  db: null as unknown,
}))

vi.mock("@/lib/auth/session", () => ({
  requireUser: async () => {
    if (!mocks.user) throw new Error("no user")
    return mocks.user
  },
}))
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const {
  addPortfolioItemAction,
  deletePortfolioItemAction,
  finishPortfolioStep,
  saveBuilderProfileAction,
  saveCreatorProfileAction,
  updatePortfolioItemAction,
} = await import("@/lib/profiles/actions")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")

beforeEach(() => {
  stubServiceEnv()
  setClockForTests(NOW)
  mocks.db = testDb.db
  mocks.user = null
})
afterEach(() => setClockForTests(null))

async function newUser(roles: ("creator" | "builder")[], name = "Ada Lovelace") {
  const row = await insertUser(testDb.db, { roles, activeRole: roles[0], name })
  const auth: AuthUser = {
    id: row.id,
    email: row.email ?? "x@example.test",
    name: row.name,
    image: null,
    roles: row.roles,
    activeRole: row.activeRole,
    status: row.status,
    onboardingCompletedAt: row.onboardingCompletedAt,
  }
  return { row, auth }
}

function creatorForm(overrides: Partial<CreatorProfileForm> = {}): CreatorProfileForm {
  return {
    displayName: "Ada Codes",
    handle: `ada_${Math.random().toString(36).slice(2, 8)}`,
    niche: "Notion tutorials",
    bio: "Weekly videos about getting organised.",
    topics: [],
    country: "DE",
    languages: ["en", "es"],
    ...overrides,
  }
}

function builderForm(overrides: Partial<BuilderProfileForm> = {}): BuilderProfileForm {
  return {
    displayName: "Octo Builder",
    handle: `octo_${Math.random().toString(36).slice(2, 8)}`,
    bio: "I build small tools.",
    skills: ["Web apps"],
    stack: ["TypeScript"],
    availability: "open",
    dealPreference: "either",
    ...overrides,
  }
}

async function eventsOf(subjectId: string, type?: string) {
  const rows = await testDb.db
    .select()
    .from(events)
    .where(eq(events.subjectId, subjectId))
    .orderBy(asc(events.occurredAt), asc(events.id))
  return type ? rows.filter((row) => row.type === type) : rows
}

async function stepsOf(userId: string) {
  const [row] = await testDb.db
    .select({ steps: users.onboardingSteps })
    .from(users)
    .where(eq(users.id, userId))
  return row?.steps ?? {}
}

/** The digest of a Next.js redirect thrown by an action, e.g. "/onboarding/creator/connect". */
async function redirectTarget(promise: Promise<unknown>): Promise<string> {
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

function formData(values: Record<string, string | string[]>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item)
  }
  return data
}

describe("handles", () => {
  it("claims a free handle, accepts one the user owns and refuses someone else's", async () => {
    const a = await newUser(["creator"])
    const b = await newUser(["builder"])
    await claimHandle(testDb.db, a.row.id, "shared_name")
    await claimHandle(testDb.db, a.row.id, "shared_name")
    await expect(claimHandle(testDb.db, b.row.id, "shared_name")).rejects.toBeInstanceOf(
      HandleTakenError,
    )
    const error = await claimHandle(testDb.db, b.row.id, "shared_name").catch((e: unknown) => e)
    expect(error).toMatchObject({
      fieldErrors: { handle: ["That handle is taken. Try another one."] },
    })
  })

  it("releases only handles no profile uses", async () => {
    const { row } = await newUser(["creator"])
    await saveCreatorProfile(testDb.db, {
      userId: row.id,
      form: creatorForm({ handle: "in_use_handle" }),
      source: "onboarding",
    })
    await claimHandle(testDb.db, row.id, "spare_handle")
    expect(await releaseUnusedHandle(testDb.db, row.id, "in_use_handle")).toBe(false)
    expect(await releaseUnusedHandle(testDb.db, row.id, "spare_handle")).toBe(true)
  })

  it("suggests the user's own handle, else a free one from their name or email", async () => {
    const { row } = await newUser(["creator"], "Grace Hopper")
    expect(await suggestHandle(testDb.db, { id: row.id, name: "Grace Hopper", email: null })).toBe(
      "grace_hopper",
    )
    const other = await newUser(["builder"])
    await claimHandle(testDb.db, other.row.id, "grace_hopper")
    const suggested = await suggestHandle(testDb.db, {
      id: row.id,
      name: "Grace Hopper",
      email: null,
    })
    expect(suggested).toMatch(/^grace_hopper_\d{2,4}$/)
    // An admin-like name falls back to a suffixed handle; a missing name uses the email.
    expect(await suggestHandle(testDb.db, { id: row.id, name: "Admin", email: null })).toMatch(
      /^admin_\d{2,4}$/,
    )
    expect(
      await suggestHandle(testDb.db, { id: row.id, name: null, email: "jo.dev@example.com" }),
    ).toBe("jo_dev")
    await claimHandle(testDb.db, row.id, "grace_codes")
    expect(await suggestHandle(testDb.db, { id: row.id, name: "Grace Hopper", email: null })).toBe(
      "grace_codes",
    )
  })
})

describe("creator profiles", () => {
  it("creates the profile, claims the handle, emits creator_profile.created and records the step", async () => {
    const { row } = await newUser(["creator"])
    const form = creatorForm()
    const result = await saveCreatorProfile(testDb.db, {
      userId: row.id,
      form,
      source: "onboarding",
    })
    expect(result).toMatchObject({
      created: true,
      fields: [],
      previousHandle: null,
      nextStep: "/onboarding/creator/connect",
    })

    const [profile] = await testDb.db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.userId, row.id))
    expect(profile).toMatchObject({
      handle: form.handle,
      displayName: "Ada Codes",
      niche: "Notion tutorials",
      country: "DE",
      languages: ["en", "es"],
      topics: [],
    })
    const [handle] = await testDb.db.select().from(handles).where(eq(handles.handle, form.handle))
    expect(handle?.userId).toBe(row.id)

    const created = await eventsOf(result.profileId, "creator_profile.created")
    expect(created.map((event) => event.properties)).toEqual([
      { country: "DE", topic_count: 0, language_count: 2 },
    ])
    expect(created[0]?.actorUserId).toBe(row.id)
    const steps = await eventsOf(row.id, "onboarding.step_completed")
    expect(steps.map((event) => event.properties)).toEqual([
      { step: "creator.profile", status: "done" },
    ])
    expect(await stepsOf(row.id)).toMatchObject({
      "creator.profile": { status: "done", at: NOW.toISOString() },
    })
  })

  it("updates only what changed, renames the handle and frees the old one", async () => {
    const { row } = await newUser(["creator"])
    const first = await saveCreatorProfile(testDb.db, {
      userId: row.id,
      form: creatorForm({ handle: "old_handle_x" }),
      source: "onboarding",
    })

    const unchanged = await saveCreatorProfile(testDb.db, {
      userId: row.id,
      form: creatorForm({ handle: "old_handle_x" }),
      source: "settings",
    })
    expect(unchanged).toMatchObject({ created: false, fields: [], previousHandle: null })
    expect(await eventsOf(first.profileId, "creator_profile.updated")).toHaveLength(0)

    const renamed = await saveCreatorProfile(testDb.db, {
      userId: row.id,
      form: creatorForm({ handle: "new_handle_x", bio: null, languages: ["es", "en"] }),
      source: "settings",
    })
    expect(renamed).toMatchObject({
      created: false,
      fields: ["handle", "bio", "languages"],
      previousHandle: "old_handle_x",
    })
    const updated = await eventsOf(first.profileId, "creator_profile.updated")
    expect(updated.map((event) => event.properties)).toEqual([
      { fields: ["handle", "bio", "languages"], source: "settings" },
    ])
    const owned = await testDb.db.select().from(handles).where(eq(handles.userId, row.id))
    expect(owned.map((handle) => handle.handle)).toEqual(["new_handle_x"])
    // The step was recorded once.
    expect(await eventsOf(row.id, "onboarding.step_completed")).toHaveLength(1)
  })

  it("refuses a handle another user holds and leaves nothing behind", async () => {
    const other = await newUser(["builder"])
    await claimHandle(testDb.db, other.row.id, "taken_handle")
    const { row } = await newUser(["creator"])
    await expect(
      saveCreatorProfile(testDb.db, {
        userId: row.id,
        form: creatorForm({ handle: "taken_handle" }),
        source: "onboarding",
      }),
    ).rejects.toBeInstanceOf(HandleTakenError)
    expect(
      await testDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.userId, row.id)),
    ).toHaveLength(0)
    expect(await eventsOf(row.id)).toHaveLength(0)
  })

  it("lets a user's creator and builder profiles share one handle", async () => {
    const { row, auth } = await newUser(["creator", "builder"])
    await saveCreatorProfile(testDb.db, {
      userId: row.id,
      form: creatorForm({ handle: "both_roles" }),
      source: "onboarding",
    })
    const builderDefaults = await builderProfilePageData(testDb.db, auth)
    expect(builderDefaults).toMatchObject({
      exists: false,
      defaults: { handle: "both_roles", displayName: "Ada Codes" },
    })
    expect(builderDefaults.sharedHandleNote).toMatch(/one handle for both/)

    const builder = await saveBuilderProfile(testDb.db, {
      userId: row.id,
      form: builderForm({ handle: "both_roles" }),
      source: "onboarding",
    })
    expect(builder.created).toBe(true)
    // Renaming one profile keeps the shared handle for the other.
    await saveBuilderProfile(testDb.db, {
      userId: row.id,
      form: builderForm({ handle: "builder_side" }),
      source: "settings",
    })
    const owned = await testDb.db
      .select({ handle: handles.handle })
      .from(handles)
      .where(eq(handles.userId, row.id))
      .orderBy(asc(handles.handle))
    expect(owned.map((handle) => handle.handle)).toEqual(["both_roles", "builder_side"])
  })

  it("prefills a new profile from the account", async () => {
    const { auth } = await newUser(["creator"], "Linus T")
    const data = await creatorProfilePageData(testDb.db, auth)
    expect(data).toMatchObject({
      exists: false,
      defaults: { displayName: "Linus T", handle: "linus_t", languages: [], country: null },
      sharedHandleNote: undefined,
    })
  })
})

describe("builder profiles", () => {
  it("creates the profile with builder_profile.created and continues to the portfolio", async () => {
    const { row } = await newUser(["builder"])
    const result = await saveBuilderProfile(testDb.db, {
      userId: row.id,
      form: builderForm({ availability: "limited", dealPreference: "split" }),
      source: "onboarding",
    })
    expect(result).toMatchObject({ created: true, nextStep: "/onboarding/builder/portfolio" })
    const created = await eventsOf(result.profileId, "builder_profile.created")
    expect(created.map((event) => event.properties)).toEqual([
      { skill_count: 1, stack_count: 1, availability: "limited", deal_preference: "split" },
    ])

    const changed = await saveBuilderProfile(testDb.db, {
      userId: row.id,
      form: builderForm({
        handle: (
          await testDb.db.select().from(builderProfiles).where(eq(builderProfiles.userId, row.id))
        )[0]?.handle,
        availability: "closed",
        dealPreference: "split",
        stack: ["TypeScript", "Postgres"],
      }),
      source: "settings",
    })
    expect(changed.fields).toEqual(["stack", "availability"])
  })
})

describe("portfolio", () => {
  async function builderWithProfile() {
    const user = await newUser(["builder"])
    const profile = await saveBuilderProfile(testDb.db, {
      userId: user.row.id,
      form: builderForm(),
      source: "onboarding",
    })
    return { ...user, profileId: profile.profileId }
  }

  const item = {
    title: "Invoice generator",
    url: "https://invoices.example.com/",
    description: "Invoices for freelancers.",
    format: "tool" as const,
    isShipped: true,
    imageKey: null,
    removeImage: false,
  }

  it("adds, updates, lists and deletes items with builder_profile.updated events", async () => {
    const { row, profileId } = await builderWithProfile()
    const { itemId } = await addPortfolioItem(testDb.db, {
      userId: row.id,
      form: item,
      source: "onboarding",
    })
    await addPortfolioItem(testDb.db, {
      userId: row.id,
      form: { ...item, title: "Draft idea", isShipped: false, url: null },
      source: "onboarding",
    })
    expect((await listPortfolioItems(testDb.db, row.id)).map((entry) => entry.title)).toEqual([
      "Invoice generator",
      "Draft idea",
    ])
    expect(await findPortfolioItemOwner(testDb.db, itemId)).toEqual({ ownerUserId: row.id })

    expect(
      await updatePortfolioItem(testDb.db, {
        userId: row.id,
        itemId,
        form: { ...item, title: "Invoice tool" },
        source: "settings",
      }),
    ).toEqual({ itemId, removedImageKey: null })
    expect(
      await deletePortfolioItem(testDb.db, { userId: row.id, itemId, source: "settings" }),
    ).toEqual({ itemId, removedImageKey: null })
    expect(
      await deletePortfolioItem(testDb.db, { userId: row.id, itemId, source: "settings" }),
    ).toBeNull()

    const updates = await eventsOf(profileId, "builder_profile.updated")
    expect(updates.map((event) => event.properties)).toEqual([
      { fields: ["portfolio_items"], source: "onboarding" },
      { fields: ["portfolio_items"], source: "onboarding" },
      { fields: ["portfolio_items"], source: "settings" },
      { fields: ["portfolio_items"], source: "settings" },
    ])
  })

  it("never touches another builder's items and needs a profile", async () => {
    const owner = await builderWithProfile()
    const intruder = await builderWithProfile()
    const { itemId } = await addPortfolioItem(testDb.db, {
      userId: owner.row.id,
      form: item,
      source: "settings",
    })
    expect(
      await updatePortfolioItem(testDb.db, {
        userId: intruder.row.id,
        itemId,
        form: { ...item, title: "Hijacked" },
        source: "settings",
      }),
    ).toBeNull()
    expect(
      await deletePortfolioItem(testDb.db, {
        userId: intruder.row.id,
        itemId,
        source: "settings",
      }),
    ).toBeNull()
    expect((await listPortfolioItems(testDb.db, owner.row.id))[0]?.title).toBe("Invoice generator")

    const noProfile = await newUser(["builder"])
    await expect(
      addPortfolioItem(testDb.db, { userId: noProfile.row.id, form: item, source: "settings" }),
    ).rejects.toBeInstanceOf(BuilderProfileMissingError)
  })

  it("holds at most 12 items", async () => {
    const { row } = await builderWithProfile()
    for (let index = 0; index < 12; index++) {
      await addPortfolioItem(testDb.db, {
        userId: row.id,
        form: { ...item, title: `Project ${index}` },
        source: "settings",
      })
    }
    await expect(
      addPortfolioItem(testDb.db, { userId: row.id, form: item, source: "settings" }),
    ).rejects.toThrow("You can show up to 12 projects")
  })

  it("re-embeds the builder from skills, stack, bio and portfolio", async () => {
    const { row } = await builderWithProfile()
    await addPortfolioItem(testDb.db, { userId: row.id, form: item, source: "settings" })
    expect(await refreshBuilderEmbedding(testDb.db, row.id)).toBe("updated")
    const [profile] = await testDb.db
      .select()
      .from(builderProfiles)
      .where(eq(builderProfiles.userId, row.id))
    expect(profile?.embedding).toHaveLength(1024)
    expect(profile?.embeddingModel).toBe("fake:hashed-bow-1024")
    expect(
      builderProfileEmbeddingText({
        bio: "Hi",
        skills: ["Web apps"],
        stack: [],
        portfolio: [{ title: "X", description: null, format: "tool", isShipped: false }],
      }),
    ).toBe("Skills: Web apps\nAbout: Hi\nBuilt: X (Tool, in progress)")
    expect(await refreshBuilderEmbedding(testDb.db, (await newUser(["builder"])).row.id)).toBe(
      "skipped",
    )
  })
})

describe("server actions", () => {
  it("the onboarding creator form creates the profile and redirects to the next step", async () => {
    const { row, auth } = await newUser(["creator"])
    mocks.user = auth
    const target = await redirectTarget(
      saveCreatorProfileAction(
        formData({
          from: "onboarding",
          displayName: " Ada ",
          handle: "@Ada_Action",
          niche: "",
          bio: "",
          country: "ES",
          languages: ["en", "es"],
        }),
      ),
    )
    expect(target).toBe("/onboarding/creator/connect")
    const [profile] = await testDb.db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.userId, row.id))
    expect(profile).toMatchObject({ handle: "ada_action", displayName: "Ada", country: "ES" })
    // The embedding was refreshed after the commit (inline outside a request).
    expect(profile?.embedding).toHaveLength(1024)
  })

  it("returns field errors for a taken or invalid handle", async () => {
    const other = await newUser(["builder"])
    await claimHandle(testDb.db, other.row.id, "taken_by_other")
    const { auth } = await newUser(["creator"])
    mocks.user = auth
    const taken = await saveCreatorProfileAction({
      from: "settings",
      displayName: "Ada",
      handle: "taken_by_other",
    })
    expect(taken).toEqual({
      ok: false,
      error: "That handle is taken. Try another one.",
      fieldErrors: { handle: ["That handle is taken. Try another one."] },
    })
    const invalid = await saveCreatorProfileAction({
      from: "settings",
      displayName: "Ada",
      handle: "no",
    })
    expect(invalid).toMatchObject({ ok: false, fieldErrors: { handle: [expect.any(String)] } })
  })

  it("refuses users without the role (§4 authorize)", async () => {
    const { auth } = await newUser(["builder"])
    mocks.user = auth
    expect(
      await saveCreatorProfileAction({ from: "settings", displayName: "Ada", handle: "ada_x1" }),
    ).toEqual({ ok: false, error: "You don't have permission to do that." })
    const creator = await newUser(["creator"])
    mocks.user = creator.auth
    expect(await addPortfolioItemAction({ from: "settings", title: "Something" })).toEqual({
      ok: false,
      error: "You don't have permission to do that.",
    })
  })

  it("settings saves return data; portfolio actions check ownership", async () => {
    const owner = await newUser(["builder"])
    mocks.user = owner.auth
    const saved = await saveBuilderProfileAction({
      from: "settings",
      displayName: "Octo",
      handle: "octo_actions",
      availability: "open",
      dealPreference: "either",
    })
    expect(saved).toEqual({
      ok: true,
      data: { created: true, changed: false, handle: "octo_actions" },
    })
    const added = await addPortfolioItemAction(
      formData({ from: "settings", title: "CLI tool", url: "cli.example.com", isShipped: "on" }),
    )
    expect(added.ok).toBe(true)
    const itemId = added.ok ? added.data.itemId : ""
    const [stored] = await testDb.db
      .select()
      .from(portfolioItems)
      .where(eq(portfolioItems.id, itemId))
    expect(stored).toMatchObject({ url: "https://cli.example.com/", isShipped: true })

    const intruder = await newUser(["builder"])
    mocks.user = intruder.auth
    expect(
      await updatePortfolioItemAction({ itemId, from: "settings", title: "Mine now" }),
    ).toEqual({ ok: false, error: "You don't have permission to do that." })
    expect(await deletePortfolioItemAction({ itemId, from: "settings" })).toEqual({
      ok: false,
      error: "You don't have permission to do that.",
    })

    mocks.user = owner.auth
    expect(await deletePortfolioItemAction({ itemId, from: "settings" })).toEqual({
      ok: true,
      data: { itemId },
    })
  })

  it("finishing the portfolio step needs a project or GitHub", async () => {
    const { row, auth } = await newUser(["builder"])
    mocks.user = auth
    await saveBuilderProfile(testDb.db, {
      userId: row.id,
      form: builderForm(),
      source: "onboarding",
    })
    expect(await finishPortfolioStep({})).toEqual({
      ok: false,
      error: "Add a project or connect GitHub first, or choose “Do this later”.",
    })
    await insertSocialConnection(testDb.db, row.id, { provider: "github" })
    expect(await redirectTarget(finishPortfolioStep({}))).toBe("/onboarding/payouts")
    expect(await stepsOf(row.id)).toMatchObject({ "builder.portfolio": { status: "done" } })
  })
})

describe("account settings", () => {
  it("renames the account and signs out every session", async () => {
    const { row } = await newUser(["creator"])
    expect(await updateAccountName(testDb.db, { userId: row.id, name: "Ada L." })).toBe(true)
    const [renamed] = await testDb.db.select().from(users).where(eq(users.id, row.id))
    expect(renamed?.name).toBe("Ada L.")

    const expires = new Date(NOW.getTime() + 86_400_000)
    await testDb.db.insert(sessions).values([
      { sessionToken: `a-${row.id}`, userId: row.id, expires },
      { sessionToken: `b-${row.id}`, userId: row.id, expires },
    ])
    const other = await newUser(["builder"])
    await testDb.db
      .insert(sessions)
      .values({ sessionToken: `c-${other.row.id}`, userId: other.row.id, expires })
    expect(await countSessions(testDb.db, row.id)).toBe(2)
    expect(await deleteAllSessions(testDb.db, row.id)).toBe(2)
    expect(await countSessions(testDb.db, row.id)).toBe(0)
    expect(await countSessions(testDb.db, other.row.id)).toBe(1)
  })

  it("stores notification preferences per type (both on by default)", async () => {
    const { row } = await newUser(["creator"])
    expect(await loadNotificationPrefs(testDb.db, row.id)).toEqual([
      { type: "social.expired", email: true, inApp: true },
      { type: "payouts.ready", email: true, inApp: true },
    ])
    await saveNotificationPrefs(testDb.db, row.id, [
      { type: "social.expired", email: false, inApp: true },
      { type: "payouts.ready", email: true, inApp: false },
    ])
    await saveNotificationPrefs(testDb.db, row.id, [
      { type: "social.expired", email: false, inApp: false },
      { type: "payouts.ready", email: true, inApp: false },
    ])
    expect(await loadNotificationPrefs(testDb.db, row.id)).toEqual([
      { type: "social.expired", email: false, inApp: false },
      { type: "payouts.ready", email: true, inApp: false },
    ])
    expect(
      await testDb.db
        .select()
        .from(notificationPrefs)
        .where(and(eq(notificationPrefs.userId, row.id))),
    ).toHaveLength(2)
  })
})
