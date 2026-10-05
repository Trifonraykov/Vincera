import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { creatorProfiles, events, handles, portfolioItems, users } from "@/lib/db/schema"
import type {
  BuilderProfileForm,
  CreatorProfileForm,
  PortfolioItemForm,
} from "@/lib/profiles/fields"
import { claimHandle, handleAvailability, HandleTakenError } from "@/lib/profiles/handles"
import {
  isOwnPortfolioImageKey,
  portfolioImagePath,
  portfolioImagePrefix,
  portfolioUploadPrefix,
} from "@/lib/profiles/image-policy"
import { portfolioPageItems } from "@/lib/profiles/page-data"
import {
  addPortfolioItem,
  deletePortfolioItem,
  listPortfolioItems,
  updatePortfolioItem,
} from "@/lib/profiles/portfolio"
import {
  createPortfolioImageUpload,
  deletePortfolioImage,
  portfolioImageResponse,
  portfolioImageUrl,
} from "@/lib/profiles/portfolio-image"
import { saveBuilderProfile, saveCreatorProfile } from "@/lib/profiles/save"
import { createLocalStorage } from "@/lib/storage/local"
import type { ObjectStorage } from "@/lib/storage/types"

import { setupTestDatabase } from "../../helpers/db"
import { insertPortfolioItem, insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"

/**
 * Profile forms, second pass (CLAUDE.md §19.17): the live handle check, concurrent saves (two
 * people racing for one handle get a plain-language error; a double submit creates one profile),
 * creator topics and when they are pinned against the audience summary, portfolio images (upload
 * URL, ownership and policy checks on the stored object, replacement and removal, the image
 * route) and the new server actions' authorization.
 */

const mocks = vi.hoisted(() => ({
  user: null as AuthUser | null,
  db: null as unknown,
  storage: null as unknown,
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
vi.mock("@/lib/storage/r2", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage/r2")>()
  return { ...original, getStorage: () => mocks.storage }
})

const {
  addPortfolioItemAction,
  checkHandleAvailabilityAction,
  requestPortfolioImageUpload,
  updatePortfolioItemAction,
} = await import("@/lib/profiles/actions")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

let storageRoot = ""
let storage: ObjectStorage

beforeAll(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), "profile-forms-test-"))
})
afterAll(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
})

beforeEach(() => {
  stubServiceEnv()
  setClockForTests(NOW)
  mocks.db = testDb.db
  mocks.user = null
  storage = createLocalStorage(storageRoot)
  mocks.storage = storage
})
afterEach(() => setClockForTests(null))

let counter = 0
function unique(prefix: string): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}${counter}`
}

async function newUser(roles: ("creator" | "builder")[]) {
  const row = await insertUser(testDb.db, { roles, activeRole: roles[0] ?? null })
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
    handle: unique("ada"),
    niche: "Notion tutorials",
    bio: null,
    topics: [],
    country: null,
    languages: [],
    ...overrides,
  }
}

function builderForm(overrides: Partial<BuilderProfileForm> = {}): BuilderProfileForm {
  return {
    displayName: "Octo Builder",
    handle: unique("octo"),
    bio: null,
    skills: [],
    stack: [],
    availability: "open",
    dealPreference: "either",
    ...overrides,
  }
}

function itemForm(overrides: Partial<PortfolioItemForm> = {}): PortfolioItemForm {
  return {
    title: "Invoice generator",
    url: null,
    description: null,
    format: null,
    isShipped: false,
    imageKey: null,
    removeImage: false,
    ...overrides,
  }
}

async function eventsOf(subjectId: string, type: string) {
  return testDb.db
    .select()
    .from(events)
    .where(and(eq(events.subjectId, subjectId), eq(events.type, type)))
}

describe("live handle check", () => {
  it("answers available, yours, taken, reserved or invalid", async () => {
    const me = await newUser(["creator"])
    const other = await newUser(["builder"])
    const mine = unique("mine")
    const theirs = unique("theirs")
    await claimHandle(testDb.db, me.row.id, mine)
    await claimHandle(testDb.db, other.row.id, theirs)

    const free = unique("free")
    expect(await handleAvailability(testDb.db, me.row.id, ` @${free.toUpperCase()} `)).toEqual({
      handle: free,
      status: "available",
      message: "Available.",
    })
    expect(await handleAvailability(testDb.db, me.row.id, mine)).toMatchObject({
      status: "yours",
    })
    expect(await handleAvailability(testDb.db, me.row.id, theirs)).toEqual({
      handle: theirs,
      status: "taken",
      message: "That handle is taken. Try another one.",
    })
    expect(await handleAvailability(testDb.db, me.row.id, "Settings")).toEqual({
      handle: "settings",
      status: "reserved",
      message: "That handle is reserved. Try another.",
    })
    expect(await handleAvailability(testDb.db, me.row.id, "a.b")).toMatchObject({
      status: "invalid",
      message: "Use 3–30 lowercase letters, numbers or underscores.",
    })
  })

  it("the action needs a signed-in, active user and answers per user", async () => {
    const { auth } = await newUser(["creator"])
    mocks.user = auth
    const free = unique("act")
    expect(await checkHandleAvailabilityAction({ handle: free })).toEqual({
      ok: true,
      data: { handle: free, status: "available", message: "Available." },
    })
    mocks.user = { ...auth, status: "suspended" }
    expect(await checkHandleAvailabilityAction({ handle: free })).toEqual({
      ok: false,
      error: "You don't have permission to do that.",
    })
  })
})

describe("concurrent saves", () => {
  it("two people racing for one handle: one gets it, the other a plain-language error", async () => {
    for (let round = 0; round < 5; round++) {
      const handle = unique("race")
      const a = await newUser(["creator"])
      const b = await newUser(["builder"])
      const results = await Promise.allSettled([
        saveCreatorProfile(testDb.db, {
          userId: a.row.id,
          form: creatorForm({ handle }),
          source: "onboarding",
        }),
        saveBuilderProfile(testDb.db, {
          userId: b.row.id,
          form: builderForm({ handle }),
          source: "onboarding",
        }),
      ])
      const fulfilled = results.filter((result) => result.status === "fulfilled")
      const rejected = results.filter((result) => result.status === "rejected")
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      const reason = (rejected[0] as PromiseRejectedResult).reason as unknown
      expect(reason).toBeInstanceOf(HandleTakenError)
      expect(reason).toMatchObject({
        message: "That handle is taken. Try another one.",
        fieldErrors: { handle: ["That handle is taken. Try another one."] },
      })
      const owners = await testDb.db.select().from(handles).where(eq(handles.handle, handle))
      expect(owners).toHaveLength(1)
    }
  })

  it("a save that waits on another user's uncommitted claim gets the plain-language error", async () => {
    const handle = unique("held")
    const holder = await newUser(["creator"])
    const latecomer = await newUser(["creator"])
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let claimed: () => void = () => {}
    const claimedOnce = new Promise<void>((resolve) => {
      claimed = resolve
    })
    // The holder claims the handle and keeps its transaction open.
    const holding = testDb.db.transaction(async (tx) => {
      await claimHandle(tx, holder.row.id, handle)
      claimed()
      await released
    })
    await claimedOnce
    // The latecomer's insert blocks on the uncommitted row, then sees it committed.
    const late = saveCreatorProfile(testDb.db, {
      userId: latecomer.row.id,
      form: creatorForm({ handle }),
      source: "onboarding",
    }).catch((error: unknown) => error)
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()
    await holding
    const error = await late
    expect(error).toBeInstanceOf(HandleTakenError)
    expect((error as Error).message).toBe("That handle is taken. Try another one.")
    expect(
      await testDb.db
        .select()
        .from(creatorProfiles)
        .where(eq(creatorProfiles.userId, latecomer.row.id)),
    ).toHaveLength(0)
  })

  it("a double submit by one user creates one profile; the second save updates it", async () => {
    const { row } = await newUser(["creator"])
    const handle = unique("double")
    const results = await Promise.allSettled([
      saveCreatorProfile(testDb.db, {
        userId: row.id,
        form: creatorForm({ handle }),
        source: "onboarding",
      }),
      saveCreatorProfile(testDb.db, {
        userId: row.id,
        form: creatorForm({ handle, niche: "Second tab" }),
        source: "onboarding",
      }),
    ])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])
    const created = results.filter(
      (result) => result.status === "fulfilled" && result.value.created,
    )
    expect(created).toHaveLength(1)
    const profiles = await testDb.db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.userId, row.id))
    expect(profiles).toHaveLength(1)
    expect(await eventsOf(profiles[0]?.id ?? "", "creator_profile.created")).toHaveLength(1)
  })
})

describe("creator topics", () => {
  it("stores the creator's topics and counts them in creator_profile.created", async () => {
    const { row } = await newUser(["creator"])
    const result = await saveCreatorProfile(testDb.db, {
      userId: row.id,
      form: creatorForm({ topics: ["meal prep", "budget recipes"] }),
      source: "onboarding",
    })
    const [profile] = await testDb.db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.id, result.profileId))
    expect(profile?.topics).toEqual(["meal prep", "budget recipes"])
    expect(profile?.audienceSummaryEditedAt).toBeNull()
    const [created] = await eventsOf(result.profileId, "creator_profile.created")
    expect(created?.properties).toMatchObject({ topic_count: 2 })
  })

  it("topics only seed the first summary; once a summary exists, edits are pinned", async () => {
    const { row } = await newUser(["creator"])
    const handle = unique("topics")
    const first = await saveCreatorProfile(testDb.db, {
      userId: row.id,
      form: creatorForm({ handle, topics: ["cooking"] }),
      source: "onboarding",
    })
    // No summary yet: the change is stored but the next sync may still write AI topics.
    const seeded = await saveCreatorProfile(testDb.db, {
      userId: row.id,
      form: creatorForm({ handle, topics: ["cooking", "students"] }),
      source: "settings",
    })
    expect(seeded.fields).toEqual(["topics"])
    let [profile] = await testDb.db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.id, first.profileId))
    expect(profile?.audienceSummaryEditedAt).toBeNull()

    // A summary exists (written by a sync): topic edits now keep the creator's version.
    await testDb.db
      .update(creatorProfiles)
      .set({ audienceSummary: "Students who cook.", audienceSummaryGeneratedAt: NOW })
      .where(eq(creatorProfiles.id, first.profileId))
    const pinned = await saveCreatorProfile(testDb.db, {
      userId: row.id,
      form: creatorForm({ handle, topics: ["student cooking"] }),
      source: "settings",
    })
    expect(pinned.fields).toEqual(["topics"])
    ;[profile] = await testDb.db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.id, first.profileId))
    expect(profile?.topics).toEqual(["student cooking"])
    expect(profile?.audienceSummaryEditedAt).toEqual(NOW)

    // Other edits never pin the summary.
    await testDb.db
      .update(creatorProfiles)
      .set({ audienceSummaryEditedAt: null })
      .where(eq(creatorProfiles.id, first.profileId))
    await saveCreatorProfile(testDb.db, {
      userId: row.id,
      form: creatorForm({ handle, topics: ["student cooking"], niche: "Cheap meals" }),
      source: "settings",
    })
    ;[profile] = await testDb.db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.id, first.profileId))
    expect(profile?.audienceSummaryEditedAt).toBeNull()
  })
})

describe("portfolio images", () => {
  async function builder() {
    const user = await newUser(["builder"])
    await saveBuilderProfile(testDb.db, {
      userId: user.row.id,
      form: builderForm(),
      source: "onboarding",
    })
    return user
  }

  async function uploadedImage(userId: string, contentType = "image/png", body = PNG) {
    const upload = await createPortfolioImageUpload(
      { userId, contentType, sizeBytes: body.byteLength },
      storage,
    )
    await storage.putObject(upload.key, body, contentType)
    return upload.key
  }

  it("issues signed upload URLs only for allowed images under the user's prefix", async () => {
    const { row } = await newUser(["builder"])
    const upload = await createPortfolioImageUpload(
      { userId: row.id, contentType: "image/webp", sizeBytes: 2048 },
      storage,
    )
    expect(upload.key.startsWith(portfolioUploadPrefix(row.id))).toBe(true)
    expect(upload.key).toMatch(/\.webp$/)
    expect(upload).toMatchObject({ contentType: "image/webp", maxBytes: 10 * 1024 * 1024 })
    expect(upload.uploadUrl).toContain("/api/dev/storage/")

    await expect(
      createPortfolioImageUpload(
        { userId: row.id, contentType: "image/svg+xml", sizeBytes: 10 },
        storage,
      ),
    ).rejects.toThrow("Upload a PNG, JPEG, WebP or GIF image.")
    await expect(
      createPortfolioImageUpload(
        { userId: row.id, contentType: "image/png", sizeBytes: 10 * 1024 * 1024 + 1 },
        storage,
      ),
    ).rejects.toThrow("This image is too large. The limit is 10 MB.")
  })

  /** Keys stored under a prefix in the local fake (its objects live in <root>/objects/<key>). */
  async function keysUnder(prefix: string): Promise<string[]> {
    const dir = path.join(storageRoot, "objects", prefix)
    const names = await readdir(dir).catch(() => [] as string[])
    return names.map((name) => `${prefix}${name}`)
  }

  async function storedImageKey(itemId: string): Promise<string | null> {
    const [row] = await testDb.db
      .select({ imageUrl: portfolioItems.imageUrl })
      .from(portfolioItems)
      .where(eq(portfolioItems.id, itemId))
    return row?.imageUrl ?? null
  }

  it("stores an uploaded image, replaces and removes it, and hands back the old key", async () => {
    const { row } = await builder()
    const first = await uploadedImage(row.id)
    expect(first.startsWith(portfolioUploadPrefix(row.id))).toBe(true)
    const { itemId } = await addPortfolioItem(
      testDb.db,
      { userId: row.id, form: itemForm({ imageKey: first }), source: "onboarding" },
      storage,
    )
    // Saved under a new key of its own; the upload is gone.
    const firstImage = await storedImageKey(itemId)
    expect(firstImage && isOwnPortfolioImageKey(row.id, firstImage)).toBe(true)
    expect(await storage.statObject(firstImage ?? "")).toEqual({
      contentType: "image/png",
      sizeBytes: PNG.byteLength,
    })
    expect(await storage.statObject(first)).toBeNull()

    // Saving without a new image keeps the current one, and so does sending the item's own key.
    for (const imageKey of [null, firstImage]) {
      expect(
        await updatePortfolioItem(
          testDb.db,
          {
            userId: row.id,
            itemId,
            form: itemForm({ title: "Renamed", imageKey }),
            source: "settings",
          },
          storage,
        ),
      ).toEqual({ itemId, removedImageKey: null })
    }
    expect(await storedImageKey(itemId)).toBe(firstImage)

    const second = await uploadedImage(row.id, "image/jpeg")
    expect(
      await updatePortfolioItem(
        testDb.db,
        { userId: row.id, itemId, form: itemForm({ imageKey: second }), source: "settings" },
        storage,
      ),
    ).toEqual({ itemId, removedImageKey: firstImage })
    const secondImage = await storedImageKey(itemId)
    expect(secondImage).toMatch(/\.jpg$/)
    expect(await storage.statObject(second)).toBeNull()

    expect(
      await updatePortfolioItem(
        testDb.db,
        { userId: row.id, itemId, form: itemForm({ removeImage: true }), source: "settings" },
        storage,
      ),
    ).toEqual({ itemId, removedImageKey: secondImage })
    expect(await storedImageKey(itemId)).toBeNull()

    const third = await uploadedImage(row.id)
    await updatePortfolioItem(
      testDb.db,
      { userId: row.id, itemId, form: itemForm({ imageKey: third }), source: "settings" },
      storage,
    )
    const thirdImage = await storedImageKey(itemId)
    expect(
      await deletePortfolioItem(testDb.db, { userId: row.id, itemId, source: "settings" }),
    ).toEqual({ itemId, removedImageKey: thirdImage })
  })

  it("refuses keys of other users, missing uploads and objects that break the policy", async () => {
    const { row } = await builder()
    const other = await builder()
    const othersKey = await uploadedImage(other.row.id)
    await expect(
      addPortfolioItem(
        testDb.db,
        { userId: row.id, form: itemForm({ imageKey: othersKey }), source: "settings" },
        storage,
      ),
    ).rejects.toThrow("Upload the image again, then save the project.")
    // Another user's upload is left alone.
    expect(await storage.statObject(othersKey)).not.toBeNull()
    await expect(
      addPortfolioItem(
        testDb.db,
        {
          userId: row.id,
          form: itemForm({ imageKey: `social-evidence/${row.id}/x.png` }),
          source: "settings",
        },
        storage,
      ),
    ).rejects.toThrow("Upload the image again, then save the project.")

    const never = (
      await createPortfolioImageUpload(
        { userId: row.id, contentType: "image/png", sizeBytes: 100 },
        storage,
      )
    ).key
    await expect(
      addPortfolioItem(
        testDb.db,
        { userId: row.id, form: itemForm({ imageKey: never }), source: "settings" },
        storage,
      ),
    ).rejects.toThrow("We didn't receive your image. Please upload it again.")

    // R2 cannot stop a wrong type or size at upload time: the stored object is checked and deleted.
    const html = (
      await createPortfolioImageUpload(
        { userId: row.id, contentType: "image/png", sizeBytes: 100 },
        storage,
      )
    ).key
    await storage.putObject(html, "<script>alert(1)</script>", "text/html")
    await expect(
      addPortfolioItem(
        testDb.db,
        { userId: row.id, form: itemForm({ imageKey: html }), source: "settings" },
        storage,
      ),
    ).rejects.toThrow("Upload a PNG, JPEG, WebP or GIF image.")
    expect(await storage.statObject(html)).toBeNull()

    const huge = (
      await createPortfolioImageUpload(
        { userId: row.id, contentType: "image/png", sizeBytes: 100 },
        storage,
      )
    ).key
    await storage.putObject(huge, new Uint8Array(10 * 1024 * 1024 + 1), "image/png")
    await expect(
      addPortfolioItem(
        testDb.db,
        { userId: row.id, form: itemForm({ imageKey: huge }), source: "settings" },
        storage,
      ),
    ).rejects.toThrow("This image is too large.")
    expect(await storage.statObject(huge)).toBeNull()
    expect(await listPortfolioItems(testDb.db, row.id)).toHaveLength(0)
    // Nothing was left behind: no saved images, no uploads of this user.
    expect(await keysUnder(portfolioImagePrefix(row.id))).toEqual([])
    expect(await keysUnder(portfolioUploadPrefix(row.id))).toEqual([])
  })

  it("a still-valid upload URL cannot change a saved image (it was copied to a new key)", async () => {
    const { row } = await builder()
    const upload = await createPortfolioImageUpload(
      { userId: row.id, contentType: "image/png", sizeBytes: PNG.byteLength },
      storage,
    )
    await storage.putObject(upload.key, PNG, "image/png")
    const { itemId } = await addPortfolioItem(
      testDb.db,
      { userId: row.id, form: itemForm({ imageKey: upload.key }), source: "settings" },
      storage,
    )
    const saved = await storedImageKey(itemId)
    expect(saved).not.toBe(upload.key)

    // The PUT URL is reusable until it expires: write 2.5 MB of HTML to the upload key again.
    await storage.putObject(upload.key, "<html>".repeat(500_000), "image/png")
    const response = await portfolioImageResponse(itemId, { db: testDb.db, storage })
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toContain(`/api/dev/storage/${saved}`)
    expect(response.headers.get("location")).not.toContain(upload.key)
    const served = await storage.getObject(saved ?? "")
    expect(served && Buffer.from(served.body)).toEqual(Buffer.from(PNG))
  })

  it("never lets two projects share an image key", async () => {
    const { row } = await builder()
    const key = await uploadedImage(row.id)
    const { itemId: a } = await addPortfolioItem(
      testDb.db,
      { userId: row.id, form: itemForm({ title: "A", imageKey: key }), source: "settings" },
      storage,
    )
    const aImage = await storedImageKey(a)
    // The same upload again (a replayed save): it was used up.
    await expect(
      addPortfolioItem(
        testDb.db,
        { userId: row.id, form: itemForm({ title: "B", imageKey: key }), source: "settings" },
        storage,
      ),
    ).rejects.toThrow("We didn't receive your image. Please upload it again.")
    // Another project's saved key, on a new project or an existing one: refused.
    await expect(
      addPortfolioItem(
        testDb.db,
        { userId: row.id, form: itemForm({ title: "B", imageKey: aImage }), source: "settings" },
        storage,
      ),
    ).rejects.toThrow("Upload the image again, then save the project.")
    const { itemId: b } = await addPortfolioItem(
      testDb.db,
      { userId: row.id, form: itemForm({ title: "B" }), source: "settings" },
      storage,
    )
    await expect(
      updatePortfolioItem(
        testDb.db,
        {
          userId: row.id,
          itemId: b,
          form: itemForm({ title: "B", imageKey: aImage }),
          source: "settings",
        },
        storage,
      ),
    ).rejects.toThrow("Upload the image again, then save the project.")
    expect(await storedImageKey(b)).toBeNull()

    // Rows saved before keys were per project may share one: deleting one row's image skips a key
    // another row still shows.
    const [profile] = await testDb.db
      .select({ id: portfolioItems.builderProfileId })
      .from(portfolioItems)
      .where(eq(portfolioItems.id, a))
    const legacy = await insertPortfolioItem(testDb.db, profile?.id ?? "", { imageUrl: aImage })
    const removed = await deletePortfolioItem(testDb.db, {
      userId: row.id,
      itemId: a,
      source: "settings",
    })
    expect(removed?.removedImageKey).toBe(aImage)
    await deletePortfolioImage(testDb.db, removed?.removedImageKey ?? null, storage)
    expect(await storage.statObject(aImage ?? "")).not.toBeNull()
    expect((await portfolioImageResponse(legacy.id, { db: testDb.db, storage })).status).toBe(302)
    await deletePortfolioItem(testDb.db, { userId: row.id, itemId: legacy.id, source: "settings" })
    await deletePortfolioImage(testDb.db, aImage, storage)
    expect(await storage.statObject(aImage ?? "")).toBeNull()
  })

  it("deletes the upload and the copy when the save is refused", async () => {
    const { row, auth } = await builder()
    // Twelve projects: the limit.
    for (let index = 0; index < 12; index += 1) {
      await addPortfolioItem(
        testDb.db,
        { userId: row.id, form: itemForm({ title: `P${index}` }), source: "settings" },
        storage,
      )
    }
    const key = await uploadedImage(row.id)
    await expect(
      addPortfolioItem(
        testDb.db,
        {
          userId: row.id,
          form: itemForm({ title: "Thirteen", imageKey: key }),
          source: "settings",
        },
        storage,
      ),
    ).rejects.toThrow("You can show up to 12 projects.")
    expect(await keysUnder(portfolioUploadPrefix(row.id))).toEqual([])
    expect(await keysUnder(portfolioImagePrefix(row.id))).toEqual([])

    // Through the action: invalid fields are refused before the save runs, and the upload goes.
    mocks.user = auth
    const items = await listPortfolioItems(testDb.db, row.id)
    const itemId = items[0]?.id ?? ""
    const forAdd = await uploadedImage(row.id)
    expect(await addPortfolioItemAction({ from: "settings", title: "", imageKey: forAdd })).toEqual(
      {
        ok: false,
        // The same answer `input` parsing gives (defineAction's invalid-input message).
        error: "Please check the highlighted fields and try again.",
        fieldErrors: { title: ["Give it a title."] },
      },
    )
    const forUpdate = await uploadedImage(row.id)
    expect(
      await updatePortfolioItemAction({
        itemId,
        from: "settings",
        title: "x".repeat(81),
        imageKey: forUpdate,
      }),
    ).toMatchObject({ ok: false, fieldErrors: { title: [expect.any(String)] } })
    // An item that is gone: the upload goes too.
    const forGone = await uploadedImage(row.id)
    expect(
      await updatePortfolioItem(
        testDb.db,
        {
          userId: row.id,
          itemId: "0199a000-0000-7000-8000-00000000dead",
          form: itemForm({ imageKey: forGone }),
          source: "settings",
        },
        storage,
      ),
    ).toBeNull()
    expect(await keysUnder(portfolioUploadPrefix(row.id))).toEqual([])
    expect(await keysUnder(portfolioImagePrefix(row.id))).toEqual([])

    // And an accepted save through the action stores a copy and drops the upload.
    const accepted = await uploadedImage(row.id)
    expect(
      await updatePortfolioItemAction({
        itemId,
        from: "settings",
        title: "With image",
        imageKey: accepted,
      }),
    ).toEqual({ ok: true, data: { itemId } })
    expect(await keysUnder(portfolioUploadPrefix(row.id))).toEqual([])
    expect(await keysUnder(portfolioImagePrefix(row.id))).toEqual([await storedImageKey(itemId)])
  })

  it("serves images through a redirect to a signed URL, never for suspended owners", async () => {
    const { row } = await builder()
    const key = await uploadedImage(row.id)
    const { itemId } = await addPortfolioItem(
      testDb.db,
      { userId: row.id, form: itemForm({ imageKey: key }), source: "settings" },
      storage,
    )
    const savedKey = (await storedImageKey(itemId)) ?? ""
    const [view] = await portfolioPageItems(testDb.db, row.id)
    expect(view?.imageSrc).toBe(portfolioImagePath(itemId, savedKey))
    expect(view?.imageSrc).toMatch(new RegExp(`^/api/portfolio/${itemId}/image\\?v=`))

    const url = await portfolioImageUrl(testDb.db, itemId, storage)
    expect(url).toContain(`/api/dev/storage/${savedKey}`)
    const response = await portfolioImageResponse(itemId, { db: testDb.db, storage })
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toContain(savedKey)
    expect(response.headers.get("cache-control")).toBe("private, max-age=300")

    expect((await portfolioImageResponse("not-a-uuid", { db: testDb.db, storage })).status).toBe(
      404,
    )
    const { itemId: plain } = await addPortfolioItem(
      testDb.db,
      { userId: row.id, form: itemForm({ title: "No image" }), source: "settings" },
      storage,
    )
    expect((await portfolioImageResponse(plain, { db: testDb.db, storage })).status).toBe(404)

    await testDb.db.update(users).set({ status: "suspended" }).where(eq(users.id, row.id))
    expect(await portfolioImageUrl(testDb.db, itemId, storage)).toBeNull()
  })

  it("only builders get upload URLs (§4 authorize)", async () => {
    const creator = await newUser(["creator"])
    mocks.user = creator.auth
    expect(await requestPortfolioImageUpload({ contentType: "image/png", sizeBytes: 100 })).toEqual(
      { ok: false, error: "You don't have permission to do that." },
    )
    const builderUser = await newUser(["builder"])
    mocks.user = builderUser.auth
    const result = await requestPortfolioImageUpload({ contentType: "image/png", sizeBytes: 100 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Upload URLs only ever point at the upload prefix, never at a saved image's key.
      expect(result.data.key.startsWith(portfolioUploadPrefix(builderUser.row.id))).toBe(true)
    }
    expect(await requestPortfolioImageUpload({ contentType: "text/html", sizeBytes: 100 })).toEqual(
      { ok: false, error: "Upload a PNG, JPEG, WebP or GIF image." },
    )
  })
})
