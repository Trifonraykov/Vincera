import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { ActionError } from "@/lib/actions/errors"
import { setClockForTests } from "@/lib/clock"
import { builderProfiles, events, products } from "@/lib/db/schema"
import {
  appStoreVerificationCode,
  checkAppStoreVerification,
  connectAppStore,
  syncAppStore,
} from "@/lib/listings/app-store/service"
import {
  createFakeInternet,
  publishFakeVerificationCode,
  setFakeAppRemoved,
} from "@/lib/listings/fake/internet"
import { listingMediaResponse } from "@/lib/listings/media-route"
import { updateProduct } from "@/lib/products/save"
import { importWebListing } from "@/lib/listings/web/service"
import { createLocalStorage } from "@/lib/storage/local"
import type { ObjectStorage } from "@/lib/storage/types"

import { setupTestDatabase } from "../../helpers/db"
import { insertBuilder } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"

/**
 * Listing imports (CLAUDE.md §19.45) against the fake App Store and fake web (recorded fixtures,
 * the real safeFetch, parsing, image sniffing and storage code): upserts, idempotence, builder
 * edits kept, removed apps, verification, SSRF refusals and the media route.
 */

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-06T09:00:00.000Z")
const PINECONE = "1500000001"
const TINY_FORGE = "1500000002"

let root: string
let storage: ObjectStorage
let stateRoot: string
let deps: { transport: ReturnType<typeof createFakeInternet>; storage: ObjectStorage }

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "listings-"))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  stubServiceEnv()
  setClockForTests(NOW)
  const run = await mkdtemp(path.join(root, "run-"))
  storage = createLocalStorage(path.join(run, "storage"))
  stateRoot = path.join(run, "state")
  deps = { transport: createFakeInternet({ stateRoot }), storage }
  return () => setClockForTests(null)
})

async function listingsOf(builderProfileId: string) {
  return testDb.db
    .select()
    .from(products)
    .where(eq(products.builderProfileId, builderProfileId))
    .orderBy(products.title)
}

describe("App Store import", () => {
  it("connects by developer link and publishes every app with copied images", async () => {
    const builder = await insertBuilder(testDb.db)
    const summary = await connectAppStore(
      testDb.db,
      { userId: builder.user.id, raw: `https://apps.apple.com/us/developer/pinecone-labs/id${PINECONE}` },
      deps,
    )
    expect(summary).toMatchObject({ developerName: "Pinecone Labs", apps: 4, created: 4, updated: 0 })

    const [profile] = await testDb.db
      .select()
      .from(builderProfiles)
      .where(eq(builderProfiles.id, builder.profile.id))
    expect(profile).toMatchObject({
      appStoreDeveloperId: PINECONE,
      appStoreCountry: "us",
      appStoreVerifiedAt: null,
    })

    const rows = await listingsOf(builder.profile.id)
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row).toMatchObject({ status: "seeking", source: "app_store", format: "app", stage: "live" })
      expect(row.sourceId).toMatch(/^\d+$/)
      expect(row.description?.length).toBeGreaterThan(20)
      expect(row.topics.length).toBeGreaterThan(0)
      expect(row.tagline).toBeTruthy()
      // The icon plus iPhone screenshots, all stored under our own keys.
      expect(row.media[0]?.kind).toBe("icon")
      expect(row.media.filter((m) => m.kind === "screenshot").length).toBeGreaterThan(0)
      for (const item of row.media) {
        expect(item.key.startsWith(`product-media/${row.id}/`)).toBe(true)
        const stored = await storage.statObject(item.key)
        expect(stored?.contentType).toBe("image/png")
      }
    }
    const focus = rows.find((row) => row.title.startsWith("Focus Garden"))
    expect(focus?.sourceMeta).toMatchObject({ kind: "app_store", rating: 4.7, priceLabel: "Free" })
    // USD storefront: no euro price for matching.
    expect(focus?.targetPriceCents).toBeNull()

    const kinds = (
      await testDb.db.select({ type: events.type }).from(events).where(eq(events.subjectId, focus!.id))
    ).map((e) => e.type)
    expect(kinds).toEqual(
      expect.arrayContaining(["product.created", "product.published", "product.imported", "ai.generated"]),
    )
  })

  it("accepts an app link (its developer) and a bare id, and never duplicates on re-import", async () => {
    const builder = await insertBuilder(testDb.db)
    await connectAppStore(
      testDb.db,
      { userId: builder.user.id, raw: "apps.apple.com/gb/app/recipe-box/id6460000201" },
      deps,
    )
    const first = await listingsOf(builder.profile.id)
    expect(first).toHaveLength(4)
    const [profile] = await testDb.db
      .select({ id: builderProfiles.appStoreDeveloperId, country: builderProfiles.appStoreCountry })
      .from(builderProfiles)
      .where(eq(builderProfiles.id, builder.profile.id))
    expect(profile).toEqual({ id: TINY_FORGE, country: "gb" })

    const again = await connectAppStore(testDb.db, { userId: builder.user.id, raw: `id${TINY_FORGE}` }, deps)
    expect(again).toMatchObject({ created: 0 })
    const second = await listingsOf(builder.profile.id)
    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id))
    // Images were reused, not copied again.
    expect(second.map((row) => row.media)).toEqual(first.map((row) => row.media))
  })

  it("keeps the builder's text edits on sync and hides apps that left the store", async () => {
    const builder = await insertBuilder(testDb.db)
    await connectAppStore(testDb.db, { userId: builder.user.id, raw: PINECONE }, deps)
    const rows = await listingsOf(builder.profile.id)
    const focus = rows.find((row) => row.title.startsWith("Focus Garden"))!
    await updateProduct(testDb.db, {
      userId: builder.user.id,
      productId: focus.id,
      intent: "save",
      fields: {
        title: "Focus Garden",
        description: "My own words about it.",
        targetUser: null,
        stage: "live",
        demoUrl: focus.demoUrl,
        format: "app",
        targetPrice: null,
        topics: ["focus"],
        preferredSplitBuilderPct: null,
        exclusivity: false,
      },
    })
    const sleep = rows.find((row) => row.title.startsWith("Sleep Sounds"))!
    await setFakeAppRemoved(sleep.sourceId!, true, stateRoot)

    const summary = await syncAppStore(
      testDb.db,
      { builderProfileId: builder.profile.id, actorUserId: null, trigger: "scheduled" },
      deps,
    )
    expect(summary).toMatchObject({ apps: 3, removed: 1 })
    const after = await listingsOf(builder.profile.id)
    const editedRow = after.find((row) => row.id === focus.id)!
    expect(editedRow).toMatchObject({ title: "Focus Garden", description: "My own words about it." })
    expect(editedRow.sourceEditedAt).not.toBeNull()
    expect(editedRow.tagline).toBeNull()
    expect(after.find((row) => row.id === sleep.id)?.sourceRemovedAt).not.toBeNull()

    // Back in the store: restored on the next sync.
    await setFakeAppRemoved(sleep.sourceId!, false, stateRoot)
    const back = await syncAppStore(
      testDb.db,
      { builderProfileId: builder.profile.id, actorUserId: null, trigger: "manual" },
      deps,
    )
    expect(back).toMatchObject({ removed: 0 })
    const [restored] = await testDb.db.select().from(products).where(eq(products.id, sleep.id))
    expect(restored?.sourceRemovedAt).toBeNull()
    const imported = await testDb.db
      .select({ properties: events.properties })
      .from(events)
      .where(and(eq(events.subjectId, sleep.id), eq(events.type, "product.imported")))
    expect(imported.map((e) => (e.properties as { action: string }).action)).toEqual([
      "created",
      "removed",
      "restored",
    ])
  })

  it("verifies the account once the code is in an app description; one builder per account", async () => {
    const builder = await insertBuilder(testDb.db)
    await connectAppStore(testDb.db, { userId: builder.user.id, raw: PINECONE }, deps)
    expect(await checkAppStoreVerification(testDb.db, { userId: builder.user.id }, deps)).toEqual({
      verified: false,
      alreadyVerified: false,
    })
    await publishFakeVerificationCode(
      PINECONE,
      appStoreVerificationCode(builder.profile.id, PINECONE),
      stateRoot,
    )
    expect(await checkAppStoreVerification(testDb.db, { userId: builder.user.id }, deps)).toEqual({
      verified: true,
      alreadyVerified: false,
    })
    const [profile] = await testDb.db
      .select()
      .from(builderProfiles)
      .where(eq(builderProfiles.id, builder.profile.id))
    expect(profile?.appStoreVerificationMethod).toBe("description_code")

    // Another builder can no longer claim it.
    const other = await insertBuilder(testDb.db)
    await expect(
      connectAppStore(testDb.db, { userId: other.user.id, raw: PINECONE }, deps),
    ).rejects.toThrow(/already verified/)
  })

  it("refuses links that are not App Store links, and unknown developers", async () => {
    const builder = await insertBuilder(testDb.db)
    await expect(
      connectAppStore(testDb.db, { userId: builder.user.id, raw: "https://example.com/id123" }, deps),
    ).rejects.toBeInstanceOf(ActionError)
    await expect(
      connectAppStore(testDb.db, { userId: builder.user.id, raw: "999999999" }, deps),
    ).rejects.toThrow(/couldn't find that developer/)
  })
})

describe("web import", () => {
  it("reads a page into a listing with its icon and preview image, and updates it on re-import", async () => {
    const builder = await insertBuilder(testDb.db)
    const first = await importWebListing(
      testDb.db,
      { userId: builder.user.id, url: "go.tasktide.example/?utm_source=x" },
      deps,
    )
    expect(first.action).toBe("created")
    const [row] = await testDb.db.select().from(products).where(eq(products.id, first.productId))
    expect(row).toMatchObject({
      source: "web",
      status: "seeking",
      targetPriceCents: 900,
      sourceUrl: "https://tasktide.example/",
    })
    expect(row?.title).toContain("TaskTide")
    expect(row?.sourceMeta).toMatchObject({ kind: "web", domain: "tasktide.example", rating: 4.8 })
    expect(row?.media.map((m) => m.kind)).toEqual(["icon", "image"])

    const again = await importWebListing(
      testDb.db,
      { userId: builder.user.id, url: "https://go.tasktide.example/" },
      deps,
    )
    expect(again).toMatchObject({ productId: first.productId, action: "unchanged" })
  })

  it("makes a listing without images from a bare page (the cover is generated)", async () => {
    const builder = await insertBuilder(testDb.db)
    const result = await importWebListing(
      testDb.db,
      { userId: builder.user.id, url: "https://quietnotes.example" },
      deps,
    )
    const [row] = await testDb.db.select().from(products).where(eq(products.id, result.productId))
    expect(row?.media).toEqual([])
    expect(row?.description).toBeTruthy()
  })

  it.each([
    ["a private address", "https://intranet-dashboard.example/"],
    ["a host with one private answer", "https://mixed-answers.example/"],
    ["a redirect to cloud metadata", "https://metadata-redirect.example/"],
    ["a redirect to a private host", "https://private-redirect.example/"],
    ["a redirect loop", "https://redirect-loop.example/"],
    ["a page over 2 MB", "https://huge.example/"],
    ["a PDF", "https://pdf.example/"],
    ["loopback", "http://127.0.0.1/"],
    ["a non-web scheme", "file:///etc/passwd"],
  ])("refuses %s with a plain message and writes nothing", async (_label, url) => {
    const builder = await insertBuilder(testDb.db)
    const error = await importWebListing(testDb.db, { userId: builder.user.id, url }, deps).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ActionError)
    expect((error as ActionError).fieldErrors?.url?.length).toBe(1)
    expect(await listingsOf(builder.profile.id)).toHaveLength(0)
  })
})

describe("listing images", () => {
  it("serves copies through the media route and hides them once the listing is archived", async () => {
    const builder = await insertBuilder(testDb.db)
    const result = await importWebListing(
      testDb.db,
      { userId: builder.user.id, url: "https://tasktide.example/" },
      deps,
    )
    const [row] = await testDb.db.select().from(products).where(eq(products.id, result.productId))
    const hash = row!.media[0]!.hash
    const ok = await listingMediaResponse(
      { productId: row!.id, hash, viewer: null },
      { db: testDb.db, storage },
    )
    expect(ok.status).toBe(302)
    expect(ok.headers.get("location")).toContain("/api/dev/storage/")
    const unknown = await listingMediaResponse(
      { productId: row!.id, hash: "0".repeat(16), viewer: null },
      { db: testDb.db, storage },
    )
    expect(unknown.status).toBe(404)
    await testDb.db
      .update(products)
      .set({ status: "archived", archivedAt: NOW })
      .where(eq(products.id, row!.id))
    const hidden = await listingMediaResponse(
      { productId: row!.id, hash, viewer: null },
      { db: testDb.db, storage },
    )
    expect(hidden.status).toBe(404)
  })
})
