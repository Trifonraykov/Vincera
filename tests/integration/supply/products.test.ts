import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ACTION_MESSAGES } from "@/lib/actions/result"
import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { sha256Hex } from "@/lib/crypto"
import { collabs, products } from "@/lib/db/schema"
import { productEmbeddingText } from "@/lib/embeddings/entities"
import type { ProductFields } from "@/lib/products/fields"
import {
  countActiveCollabs,
  countOwnProducts,
  findProduct,
  listOwnProducts,
} from "@/lib/products/queries"
import { createProduct, transitionProduct, updateProduct } from "@/lib/products/save"

import { setupTestDatabase } from "../../helpers/db"
import { insertProduct, insertProposal } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import {
  eventsOf,
  formData,
  newBuilder,
  newCreator,
  newUserWithoutProfile,
  redirectTarget,
  stubMatchingJobs,
} from "./helpers"

/**
 * Products (§5, §12 `/app/products/*`, §11 `product.*`; CLAUDE.md §19.24–§19.25): writes with
 * their events and lifecycle, exclusivity, ownership, locked statuses, the server actions and the
 * embedding refresh they request.
 */

const mocks = vi.hoisted(() => ({ user: null as AuthUser | null, db: null as unknown }))

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

const { changeProductStatusAction, createProductAction, updateProductAction } =
  await import("@/lib/products/actions")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")

beforeEach(() => {
  stubServiceEnv()
  setClockForTests(NOW)
  mocks.db = testDb.db
  mocks.user = null
})
afterEach(() => setClockForTests(null))

const FIELDS: ProductFields = {
  title: "Invoice generator",
  description: "Creates **PDF invoices** in two clicks.",
  targetUser: "Freelance designers",
  stage: "beta",
  demoUrl: "https://demo.example.com/",
  format: "tool",
  targetPrice: 2900,
  topics: ["freelancing", "invoicing"],
  preferredSplitBuilderPct: 60,
  exclusivity: false,
}

async function productRow(id: string) {
  const [row] = await testDb.db.select().from(products).where(eq(products.id, id))
  if (!row) throw new Error("no product")
  return row
}

describe("product writes", () => {
  it("saves a draft with product.created, or publishes at once", async () => {
    const { user } = await newBuilder(testDb.db)
    const draft = await createProduct(testDb.db, {
      userId: user.id,
      fields: FIELDS,
      intent: "save",
    })
    expect(await productRow(draft.productId)).toMatchObject({
      status: "draft",
      stage: "beta",
      preferredSplitBuilderPct: 60,
      exclusivity: false,
      currency: "eur",
      publishedAt: null,
    })
    const [created] = await eventsOf(testDb.db, draft.productId)
    expect(created).toMatchObject({
      type: "product.created",
      actorUserId: user.id,
      properties: {
        format: "tool",
        stage: "beta",
        topics: ["freelancing", "invoicing"],
        target_price_cents: 2900,
      },
    })

    const published = await createProduct(testDb.db, {
      userId: user.id,
      fields: FIELDS,
      intent: "publish",
    })
    expect(await productRow(published.productId)).toMatchObject({
      status: "seeking",
      publishedAt: NOW,
    })
    expect((await eventsOf(testDb.db, published.productId)).map((event) => event.type)).toEqual([
      "product.created",
      "product.published",
    ])
  })

  it("needs a description and a topic to publish, and a builder profile to create", async () => {
    const { user } = await newBuilder(testDb.db)
    await expect(
      createProduct(testDb.db, {
        userId: user.id,
        fields: { ...FIELDS, description: null, topics: [] },
        intent: "publish",
      }),
    ).rejects.toMatchObject({
      fieldErrors: {
        description: ["Describe the product before publishing."],
        topics: ["Add at least one topic before publishing, so creators can find it."],
      },
    })
    const { user: noProfile } = await newUserWithoutProfile(testDb.db, "builder")
    await expect(
      createProduct(testDb.db, { userId: noProfile.id, fields: FIELDS, intent: "save" }),
    ).rejects.toThrow("Create your builder profile first.")
  })

  it("records changed columns, and archives / restores with events", async () => {
    const { user } = await newBuilder(testDb.db)
    const { productId } = await createProduct(testDb.db, {
      userId: user.id,
      fields: FIELDS,
      intent: "publish",
    })
    const result = await updateProduct(testDb.db, {
      userId: user.id,
      productId,
      fields: { ...FIELDS, stage: "live", demoUrl: null, exclusivity: true },
      intent: "save",
    })
    expect(result).toMatchObject({
      status: "seeking",
      published: false,
      fields: ["stage", "demo_url", "exclusivity"],
    })
    await transitionProduct(testDb.db, { userId: user.id, productId, action: "archive" })
    expect(await productRow(productId)).toMatchObject({ status: "archived", archivedAt: NOW })
    await transitionProduct(testDb.db, { userId: user.id, productId, action: "restore" })
    expect(await productRow(productId)).toMatchObject({ status: "draft", archivedAt: null })

    const events = await eventsOf(testDb.db, productId)
    expect(events.map((event) => [event.type, event.properties])).toEqual([
      ["product.created", expect.anything()],
      ["product.published", {}],
      ["product.updated", { fields: ["stage", "demo_url", "exclusivity"] }],
      ["product.archived", { from_status: "seeking" }],
      ["product.restored", {}],
    ])
  })

  it("stays editable while non-exclusive collabs run, but can't become exclusive then", async () => {
    const builder = await newBuilder(testDb.db)
    const creator = await newCreator(testDb.db)
    const product = await insertProduct(testDb.db, builder.profile.id, {
      status: "seeking",
      description: "d",
      topics: ["t"],
    })
    const { proposal } = await insertProposal(testDb.db, {
      fromUserId: creator.user.id,
      toUserId: builder.user.id,
      productId: product.id,
      status: "accepted",
    })
    await testDb.db.insert(collabs).values({ proposalId: proposal.id, productId: product.id })
    expect(await countActiveCollabs(testDb.db, product.id)).toBe(1)

    const edited = await updateProduct(testDb.db, {
      userId: builder.user.id,
      productId: product.id,
      fields: { ...FIELDS, title: "Invoices v2" },
      intent: "save",
    })
    expect(edited.status).toBe("seeking")
    await expect(
      updateProduct(testDb.db, {
        userId: builder.user.id,
        productId: product.id,
        fields: { ...FIELDS, exclusivity: true },
        intent: "save",
      }),
    ).rejects.toMatchObject({
      fieldErrors: {
        exclusivity: [
          "It already has a collab, so it can't become exclusive until that collab ends.",
        ],
      },
    })
    expect((await productRow(product.id)).exclusivity).toBe(false)
  })

  it("locks products in a collab or launched, and refuses other builders", async () => {
    const { user, profile } = await newBuilder(testDb.db)
    for (const status of ["in_collab", "launched"] as const) {
      const product = await insertProduct(testDb.db, profile.id, { status })
      await expect(
        updateProduct(testDb.db, {
          userId: user.id,
          productId: product.id,
          fields: FIELDS,
          intent: "save",
        }),
      ).rejects.toThrow(/so it can't be changed/)
      await expect(
        transitionProduct(testDb.db, { userId: user.id, productId: product.id, action: "archive" }),
      ).rejects.toThrow(/so it can't be changed/)
    }
    const other = await newBuilder(testDb.db)
    const theirs = await insertProduct(testDb.db, other.profile.id)
    await expect(
      transitionProduct(testDb.db, { userId: user.id, productId: theirs.id, action: "archive" }),
    ).rejects.toThrow("This product no longer exists.")
  })

  it("lists the builder's own products by filter, with counts", async () => {
    const { user, profile } = await newBuilder(testDb.db)
    await insertProduct(testDb.db, profile.id, { title: "Draft" })
    await insertProduct(testDb.db, profile.id, { title: "Seeking", status: "seeking" })
    await insertProduct(testDb.db, profile.id, { title: "Busy", status: "in_collab" })
    expect((await listOwnProducts(testDb.db, user.id, "live")).map((p) => p.title)).toEqual([
      "Seeking",
    ])
    expect((await listOwnProducts(testDb.db, user.id, "all")).length).toBe(3)
    expect(await countOwnProducts(testDb.db, user.id)).toMatchObject({
      draft: 1,
      seeking: 1,
      in_collab: 1,
      archived: 0,
    })
    const [seeking] = await listOwnProducts(testDb.db, user.id, "live")
    expect((await findProduct(testDb.db, seeking!.id))?.owner.handle).toBe(profile.handle)
  })
})

describe("product actions", () => {
  it("create: redirects, embeds after the commit and asks matching to recompute", async () => {
    const matching = stubMatchingJobs()
    const { user, auth } = await newBuilder(testDb.db)
    mocks.user = auth
    const target = await redirectTarget(
      createProductAction(
        formData({
          title: "Invoice generator",
          description: "Creates PDF invoices.",
          targetUser: "",
          stage: "prototype",
          demoUrl: "demo.example.com",
          format: "tool",
          targetPrice: "29",
          topics: "Freelancing",
          preferredSplitBuilderPct: "",
          exclusivity: "on",
          intent: "save",
        }),
      ),
    )
    const [product] = await listOwnProducts(testDb.db, user.id, "all")
    if (!product) throw new Error("not created")
    expect(target).toBe(`/app/products/${product.id}?saved=created`)
    const row = await productRow(product.id)
    expect(row).toMatchObject({
      status: "draft",
      demoUrl: "https://demo.example.com/",
      exclusivity: true,
      preferredSplitBuilderPct: null,
      embeddingTextHash: sha256Hex(productEmbeddingText(row)),
      embeddedAt: NOW,
    })
    expect(row.embedding).toHaveLength(1024)
    expect(matching.rescore[0]).toHaveBeenCalledWith({
      targetType: "product",
      targetId: product.id,
    })
    expect(matching.recompute[0]).toHaveBeenCalledWith({
      userId: user.id,
      reason: "product_changed",
    })
  })

  it("refuses creators, other builders, and invalid fields", async () => {
    stubMatchingJobs()
    const owner = await newBuilder(testDb.db)
    const { productId } = await createProduct(testDb.db, {
      userId: owner.user.id,
      fields: FIELDS,
      intent: "save",
    })

    mocks.user = (await newCreator(testDb.db)).auth
    expect(
      await createProductAction(formData({ title: "P", format: "app", stage: "idea" })),
    ).toEqual({ ok: false, error: ACTION_MESSAGES.forbidden })

    mocks.user = (await newBuilder(testDb.db)).auth
    expect(await changeProductStatusAction({ productId, action: "archive" })).toEqual({
      ok: false,
      error: ACTION_MESSAGES.forbidden,
    })

    mocks.user = owner.auth
    expect(
      await updateProductAction(
        formData({
          productId,
          title: "P",
          format: "app",
          stage: "idea",
          demoUrl: "ftp://files.example.com",
        }),
      ),
    ).toMatchObject({
      ok: false,
      fieldErrors: { demoUrl: ["Enter a web address, like https://example.com."] },
    })
    expect(
      await updateProductAction(
        formData({
          productId,
          title: "Invoices",
          description: "Made.",
          format: "tool",
          stage: "live",
          topics: "invoicing",
          intent: "publish",
        }),
      ),
    ).toMatchObject({ ok: true, data: { status: "seeking", published: true } })
    expect(await changeProductStatusAction({ productId, action: "archive" })).toEqual({
      ok: true,
      data: { status: "archived" },
    })
  })
})
