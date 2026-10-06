import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import { adminAuditLog, ideas, launches, licenseKeys, trackedLinks } from "@/lib/db/schema"
import { resetEnvCache } from "@/lib/env"
import {
  addLaunchFile,
  addLaunchMedia,
  addLicenseKeys,
  createLaunchUpload,
  removeLaunchFile,
} from "@/lib/launches/content"
import { loadPublicLaunch, loadLaunchSetup } from "@/lib/launches/queries"
import {
  adminApproveLaunch,
  adminRejectLaunch,
  approveLaunch,
  createLaunch,
  endLaunch,
  LAUNCH_ERRORS,
  pauseLaunch,
  resumeLaunch,
  saveLaunch,
} from "@/lib/launches/service"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { createLocalStorage } from "@/lib/storage/local"

import { setupTestDatabase } from "../../helpers/db"
import { insertOrder } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import {
  adminUser,
  buildingCollab,
  collabStage,
  completeFields,
  eventsOf,
  launchRow,
  notificationsOf,
  strangerUser,
} from "./helpers"

/**
 * The launch lifecycle against Postgres (§12 "Launch setup page", CLAUDE.md §19.31–§19.32): start,
 * save (approvals reset), dual approval → admin review or straight live (`AUTO_APPROVE_LAUNCHES`),
 * the admin review (approve → live, send back with a note), the go-live side effects (default
 * tracked link, idea `launched`, collab `live`, events, notices, audit log), pause/resume, files,
 * images and license keys, and who may do what. The server actions are tested at the end.
 */

const mocks = vi.hoisted(() => ({
  dir: "",
  db: null as unknown,
  user: null as AuthUser | null,
  embeddings: [] as unknown[],
}))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
vi.mock("@/lib/auth/session", () => ({
  requireUser: async () => {
    if (!mocks.user) throw new Error("no user")
    return mocks.user
  },
}))
vi.mock("@/lib/embeddings/request", () => ({
  requestEmbeddingRefreshAfterCommit: async (entity: unknown) => {
    mocks.embeddings.push(entity)
  },
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const { approveLaunchAction, saveLaunchAction, adminRejectLaunchAction, createLaunchAction } =
  await import("@/lib/launches/actions")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")

beforeAll(async () => {
  mocks.dir = await mkdtemp(path.join(tmpdir(), "launches-test-"))
})
afterAll(async () => {
  await rm(mocks.dir, { recursive: true, force: true })
})
beforeEach(() => {
  mocks.db = testDb.db
  mocks.user = null
  mocks.embeddings = []
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(async () => {
  setClockForTests(null)
  vi.unstubAllEnvs()
  resetEnvCache()
  await closeDb()
})

async function startedLaunch() {
  const people = await buildingCollab(testDb.db)
  const { launchId } = await createLaunch(testDb.db, people.creator.auth, {
    collabId: people.collab.id,
  })
  return { ...people, launchId }
}

/** A launch saved complete and approved by both members (now in `admin_review`). */
async function inReview() {
  const setup = await startedLaunch()
  await saveLaunch(testDb.db, setup.creator.auth, {
    launchId: setup.launchId,
    fields: completeFields(),
  })
  await approveLaunch(testDb.db, setup.creator.auth, { launchId: setup.launchId })
  await approveLaunch(testDb.db, setup.builder.auth, { launchId: setup.launchId })
  return setup
}

describe("starting a launch", () => {
  it("creates one draft per collab, titled and slugged after the idea", async () => {
    const people = await buildingCollab(testDb.db)
    const first = await createLaunch(testDb.db, people.builder.auth, { collabId: people.collab.id })
    expect(first.created).toBe(true)
    const row = await launchRow(testDb.db, first.launchId)
    expect(row).toMatchObject({ status: "draft", title: people.idea.title, currency: "eur" })
    expect(row.slug).toMatch(/^[a-z0-9-]{3,80}$/)
    expect(await eventsOf(testDb.db, first.launchId, "launch.created")).toHaveLength(1)

    const again = await createLaunch(testDb.db, people.creator.auth, { collabId: people.collab.id })
    expect(again).toEqual({ launchId: first.launchId, created: false })
  })

  it("needs a signed agreement (stage building) and a member", async () => {
    const unsigned = await buildingCollab(testDb.db, "agreement")
    await expect(
      createLaunch(testDb.db, unsigned.creator.auth, { collabId: unsigned.collab.id }),
    ).rejects.toThrow(LAUNCH_ERRORS.notBuilding)
    const people = await buildingCollab(testDb.db)
    await expect(
      createLaunch(testDb.db, await strangerUser(testDb.db), { collabId: people.collab.id }),
    ).rejects.toThrow(LAUNCH_ERRORS.collabNotFound)
    await expect(
      createLaunch(testDb.db, await adminUser(testDb.db), { collabId: people.collab.id }),
    ).rejects.toThrow(LAUNCH_ERRORS.collabNotFound)
  })

  it("picks a free slug when the title's is taken", async () => {
    const a = await buildingCollab(testDb.db)
    const b = await buildingCollab(testDb.db)
    for (const idea of [a.idea, b.idea]) {
      await testDb.db.update(ideas).set({ title: "Budget Tracker!" }).where(eq(ideas.id, idea.id))
    }
    const first = await createLaunch(testDb.db, a.creator.auth, { collabId: a.collab.id })
    const second = await createLaunch(testDb.db, b.creator.auth, { collabId: b.collab.id })
    expect((await launchRow(testDb.db, first.launchId)).slug).toBe("budget-tracker")
    expect((await launchRow(testDb.db, second.launchId)).slug).toBe("budget-tracker-2")
  })
})

describe("saving and approving", () => {
  it("resets approvals when a member saves a change, and sends the launch back to draft", async () => {
    const { creator, builder, launchId, collab } = await startedLaunch()
    await saveLaunch(testDb.db, creator.auth, {
      launchId,
      fields: completeFields({ slug: "planner-one" }),
    })
    const approved = await approveLaunch(testDb.db, creator.auth, { launchId })
    expect(approved).toEqual({ status: "pending_approval", allApproved: false })
    let row = await launchRow(testDb.db, launchId)
    expect(row.approvedBy).toHaveLength(1)
    expect(row.submittedAt).toEqual(NOW)
    expect(await collabStage(testDb.db, collab.id)).toBe("launch_review")
    expect(await eventsOf(testDb.db, launchId, "launch.submitted")).toHaveLength(1)
    // The other member is asked to approve.
    expect(
      await notificationsOf(testDb.db, builder.user.id, "launch.approval_requested"),
    ).toHaveLength(1)

    // Saving the same values changes nothing and resets nothing.
    const same = await saveLaunch(testDb.db, builder.auth, {
      launchId,
      fields: completeFields({ slug: "planner-one" }),
    })
    expect(same).toMatchObject({ changed: [], approvalsReset: false, status: "pending_approval" })

    const changed = await saveLaunch(testDb.db, builder.auth, {
      launchId,
      fields: completeFields({ slug: "planner-one", price: "24" }),
    })
    expect(changed).toMatchObject({
      changed: ["price_cents"],
      approvalsReset: true,
      status: "draft",
    })
    row = await launchRow(testDb.db, launchId)
    expect(row).toMatchObject({
      status: "draft",
      approvedBy: [],
      submittedAt: null,
      priceCents: 2400,
    })
    expect(row.taxCode).toBe("txcd_10103000")
    expect(await collabStage(testDb.db, collab.id)).toBe("building")
    const [updated] = (await eventsOf(testDb.db, launchId, "launch.updated")).slice(-1)
    expect(updated?.properties).toEqual({
      collab_id: collab.id,
      fields: ["price_cents"],
      approvals_reset: true,
    })
  })

  it("refuses an approval until the launch is complete, and a second approval of the same version", async () => {
    const { creator, launchId } = await startedLaunch()
    await expect(approveLaunch(testDb.db, creator.auth, { launchId })).rejects.toThrow(
      /Before approving, add a price and how buyers get the product/,
    )
    await saveLaunch(testDb.db, creator.auth, {
      launchId,
      fields: completeFields({ deliveryType: "license_key" }),
    })
    await expect(approveLaunch(testDb.db, creator.auth, { launchId })).rejects.toThrow(
      /at least one license key/,
    )
    await addLicenseKeys(testDb.db, creator.auth, { launchId, text: "KEY-1\nKEY-2\nKEY-1" })
    await approveLaunch(testDb.db, creator.auth, { launchId })
    await expect(approveLaunch(testDb.db, creator.auth, { launchId })).rejects.toThrow(
      LAUNCH_ERRORS.alreadyApproved,
    )
  })

  it("goes straight live with AUTO_APPROVE_LAUNCHES", async () => {
    stubServiceEnv({ AUTO_APPROVE_LAUNCHES: "true" })
    const { creator, builder, launchId, collab } = await startedLaunch()
    await saveLaunch(testDb.db, creator.auth, { launchId, fields: completeFields() })
    await approveLaunch(testDb.db, creator.auth, { launchId })
    const result = await approveLaunch(testDb.db, builder.auth, { launchId })
    expect(result).toEqual({ status: "live", allApproved: true })
    const row = await launchRow(testDb.db, launchId)
    expect(row.status).toBe("live")
    expect(row.wentLiveAt).toEqual(NOW)
    expect(await collabStage(testDb.db, collab.id)).toBe("live")
    const [live] = await eventsOf(testDb.db, launchId, "launch.live")
    expect(live?.properties).toMatchObject({ auto_approved: true, price_cents: 1900 })
  })
})

describe("admin review and going live", () => {
  it("both approvals → admin_review; the admin approves → live with every side effect", async () => {
    const admin = await adminUser(testDb.db)
    const { launchId, creator, builder, collab, idea } = await inReview()
    let row = await launchRow(testDb.db, launchId)
    expect(row.status).toBe("admin_review")
    expect(await collabStage(testDb.db, collab.id)).toBe("launch_review")
    expect(
      await notificationsOf(testDb.db, admin.id, "admin.launch_review_requested"),
    ).toHaveLength(1)
    expect(
      (await eventsOf(testDb.db, launchId, "launch.approved")).map((e) => e.properties),
    ).toEqual([
      { collab_id: collab.id, role: "creator" },
      { collab_id: collab.id, role: "builder" },
    ])

    // Members cannot approve in the admin's place, and admins cannot act as members.
    await expect(adminApproveLaunch(testDb.db, creator.auth, { launchId })).rejects.toThrow(
      LAUNCH_ERRORS.notFound,
    )
    await expect(approveLaunch(testDb.db, admin, { launchId })).rejects.toThrow(
      LAUNCH_ERRORS.notFound,
    )

    await adminApproveLaunch(testDb.db, admin, { launchId })
    row = await launchRow(testDb.db, launchId)
    expect(row).toMatchObject({ status: "live", reviewedByUserId: admin.id, wentLiveAt: NOW })
    expect(await collabStage(testDb.db, collab.id)).toBe("live")
    const [idea2] = await testDb.db.select().from(ideas).where(eq(ideas.id, idea.id))
    expect(idea2?.status).toBe("launched")
    expect(mocks.embeddings).toContainEqual({ type: "idea", id: idea.id })

    const links = await testDb.db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.launchId, launchId))
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      isDefault: true,
      ownerUserId: creator.user.id,
      label: "Default",
    })
    expect(links[0]?.code).toMatch(/^[0-9A-Za-z]{8}$/)
    expect(await eventsOf(testDb.db, links[0]?.id ?? "", "tracked_link.created")).toHaveLength(1)
    const [live] = await eventsOf(testDb.db, launchId, "launch.live")
    expect(live?.properties).toMatchObject({ auto_approved: false })
    for (const person of [creator, builder]) {
      expect(await notificationsOf(testDb.db, person.user.id, "launch.live")).toHaveLength(1)
    }
    const audit = await testDb.db
      .select()
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.targetId, launchId), eq(adminAuditLog.action, "launch.approved")))
    expect(audit).toHaveLength(1)

    // Public now; the slug is fixed.
    expect(await loadPublicLaunch(testDb.db, row.slug)).toMatchObject({
      status: "live",
      priceCents: 1900,
    })
    await pauseLaunch(testDb.db, creator.auth, { launchId })
    await expect(
      saveLaunch(testDb.db, creator.auth, {
        launchId,
        fields: completeFields({ slug: "new-slug" }),
      }),
    ).rejects.toThrow(LAUNCH_ERRORS.slugFixed)
  })

  it("an admin sends it back to draft with a note the members get", async () => {
    const admin = await adminUser(testDb.db)
    const { launchId, creator, builder, collab } = await inReview()
    await adminRejectLaunch(testDb.db, admin, { launchId, note: "Add screenshots, please." })
    const row = await launchRow(testDb.db, launchId)
    expect(row).toMatchObject({
      status: "draft",
      approvedBy: [],
      reviewNote: "Add screenshots, please.",
      reviewedByUserId: admin.id,
    })
    expect(await collabStage(testDb.db, collab.id)).toBe("building")
    expect(await eventsOf(testDb.db, launchId, "launch.rejected")).toHaveLength(1)
    for (const person of [creator, builder]) {
      expect(await notificationsOf(testDb.db, person.user.id, "launch.rejected")).toHaveLength(1)
    }
    await expect(adminApproveLaunch(testDb.db, admin, { launchId })).rejects.toThrow(
      LAUNCH_ERRORS.notInReview,
    )
  })
})

describe("pause, resume, end", () => {
  async function liveLaunch() {
    const admin = await adminUser(testDb.db)
    const setup = await inReview()
    await adminApproveLaunch(testDb.db, admin, { launchId: setup.launchId })
    return { ...setup, admin }
  }

  it("a member pauses and resumes; an unchanged launch needs no new review", async () => {
    const { launchId, creator, builder } = await liveLaunch()
    await expect(
      saveLaunch(testDb.db, creator.auth, { launchId, fields: completeFields() }),
    ).rejects.toThrow(LAUNCH_ERRORS.live)
    await pauseLaunch(testDb.db, creator.auth, { launchId })
    let row = await launchRow(testDb.db, launchId)
    expect(row).toMatchObject({ status: "paused", pausedBy: "member" })
    expect(await notificationsOf(testDb.db, builder.user.id, "launch.paused")).toHaveLength(1)
    expect(await notificationsOf(testDb.db, creator.user.id, "launch.paused")).toHaveLength(0)
    await resumeLaunch(testDb.db, builder.auth, { launchId })
    row = await launchRow(testDb.db, launchId)
    expect(row).toMatchObject({ status: "live", pausedAt: null, pausedBy: null })
    expect(await eventsOf(testDb.db, launchId, "launch.resumed")).toHaveLength(1)
  })

  it("an edit while paused goes back through admin review before it sells again", async () => {
    const { launchId, creator, builder, admin } = await liveLaunch()
    await pauseLaunch(testDb.db, creator.auth, { launchId })
    let row = await launchRow(testDb.db, launchId)
    await saveLaunch(testDb.db, builder.auth, {
      launchId,
      fields: completeFields({ slug: row.slug, title: "Meal planner Pro", price: "999" }),
    })
    row = await launchRow(testDb.db, launchId)
    expect(row).toMatchObject({
      status: "draft",
      approvedBy: [],
      title: "Meal planner Pro",
      pausedAt: null,
      pausedBy: null,
    })
    // The product page and the tracked links stay up, showing "not available".
    expect((await loadPublicLaunch(testDb.db, row.slug))?.status).toBe("paused")
    await expect(resumeLaunch(testDb.db, creator.auth, { launchId })).rejects.toThrow(
      LAUNCH_ERRORS.notPaused,
    )
    await approveLaunch(testDb.db, creator.auth, { launchId })
    await approveLaunch(testDb.db, builder.auth, { launchId })
    expect((await launchRow(testDb.db, launchId)).status).toBe("admin_review")
    expect(await collabStage(testDb.db, row.collabId)).toBe("live")
    await adminApproveLaunch(testDb.db, admin, { launchId })
    row = await launchRow(testDb.db, launchId)
    expect(row).toMatchObject({ status: "live", priceCents: 99900, reviewedByUserId: admin.id })
    // Going live again is not a new go-live: still one default link.
    const links = await testDb.db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.launchId, launchId))
    expect(links).toHaveLength(1)
  })

  it("with AUTO_APPROVE_LAUNCHES an edit while paused needs both approvals to resume", async () => {
    const { launchId, creator, builder } = await liveLaunch()
    await pauseLaunch(testDb.db, creator.auth, { launchId })
    const { slug } = await launchRow(testDb.db, launchId)
    await saveLaunch(
      testDb.db,
      builder.auth,
      { launchId, fields: completeFields({ slug, title: "Meal planner Pro" }) },
      { autoApprove: true },
    )
    expect(await launchRow(testDb.db, launchId)).toMatchObject({ status: "paused", approvedBy: [] })
    await expect(resumeLaunch(testDb.db, creator.auth, { launchId })).rejects.toThrow(
      LAUNCH_ERRORS.resumeNeedsApprovals,
    )
    await approveLaunch(testDb.db, creator.auth, { launchId }, { autoApprove: true })
    await approveLaunch(testDb.db, builder.auth, { launchId }, { autoApprove: true })
    expect((await launchRow(testDb.db, launchId)).status).toBe("paused")
    await resumeLaunch(testDb.db, builder.auth, { launchId })
    expect((await launchRow(testDb.db, launchId)).status).toBe("live")
  })

  it("once sold, the delivery type and URL stay as bought", async () => {
    const { launchId, creator } = await liveLaunch()
    await insertOrder(testDb.db, launchId, NOW)
    await pauseLaunch(testDb.db, creator.auth, { launchId })
    const { slug } = await launchRow(testDb.db, launchId)
    await expect(
      saveLaunch(testDb.db, creator.auth, {
        launchId,
        fields: completeFields({ slug, deliveryUrl: "https://elsewhere.example/" }),
      }),
    ).rejects.toThrow(LAUNCH_ERRORS.urlFixed)
    await expect(
      saveLaunch(testDb.db, creator.auth, {
        launchId,
        fields: completeFields({ slug, deliveryType: "file" }),
      }),
    ).rejects.toThrow(LAUNCH_ERRORS.deliveryFixed)
    // Other fields can still change.
    await saveLaunch(testDb.db, creator.auth, {
      launchId,
      fields: completeFields({ slug, title: "Meal planner 2" }),
    })
    expect((await launchRow(testDb.db, launchId)).title).toBe("Meal planner 2")
  })

  it("an admin's pause can only be lifted by an admin; ending is final and audited", async () => {
    const { launchId, creator, admin } = await liveLaunch()
    await pauseLaunch(testDb.db, admin, { launchId })
    expect((await launchRow(testDb.db, launchId)).pausedBy).toBe("admin")
    await expect(resumeLaunch(testDb.db, creator.auth, { launchId })).rejects.toThrow(
      LAUNCH_ERRORS.resumeAdminOnly,
    )
    await resumeLaunch(testDb.db, admin, { launchId })
    await endLaunch(testDb.db, admin, { launchId })
    expect((await launchRow(testDb.db, launchId)).status).toBe("ended")
    const actions = (
      await testDb.db.select().from(adminAuditLog).where(eq(adminAuditLog.targetId, launchId))
    ).map((row) => row.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        "launch.approved",
        "launch.paused",
        "launch.resumed",
        "launch.ended",
      ]),
    )
    await expect(addLicenseKeys(testDb.db, creator.auth, { launchId, text: "K" })).rejects.toThrow(
      LAUNCH_ERRORS.ended,
    )
  })
})

describe("content", () => {
  const storage = () => createLocalStorage(path.join(mocks.dir, "storage"))

  async function upload(userId: string, kind: "deliverable" | "media", type: string, body: string) {
    const { key } = await createLaunchUpload(
      { userId, kind, contentType: type, sizeBytes: body.length },
      storage(),
    )
    await storage().putObject(key, body, type)
    return key
  }

  it("adds and removes files (copied out of the upload area); each resets approvals", async () => {
    const { creator, launchId } = await startedLaunch()
    await saveLaunch(testDb.db, creator.auth, {
      launchId,
      fields: completeFields({ deliveryType: "file" }),
    })
    const key = await upload(creator.user.id, "deliverable", "application/pdf", "%PDF-1.7 hello")
    const { fileId } = await addLaunchFile(
      testDb.db,
      creator.auth,
      { launchId, uploadKey: key, filename: "../Guide.pdf" },
      storage(),
    )
    const setup = await loadLaunchSetup(testDb.db, (await launchRow(testDb.db, launchId)).collabId)
    expect(setup?.files).toEqual([
      expect.objectContaining({
        id: fileId,
        filename: "Guide.pdf",
        contentType: "application/pdf",
      }),
    ])
    await approveLaunch(testDb.db, creator.auth, { launchId })
    await removeLaunchFile(testDb.db, creator.auth, { launchId, fileId }, storage())
    expect((await launchRow(testDb.db, launchId)).status).toBe("draft")
  })

  it("keeps sold files: once there are orders a file cannot be removed", async () => {
    const { creator, launchId } = await startedLaunch()
    await saveLaunch(testDb.db, creator.auth, {
      launchId,
      fields: completeFields({ deliveryType: "file" }),
    })
    const key = await upload(creator.user.id, "deliverable", "application/pdf", "%PDF-1.7 hello")
    const { fileId } = await addLaunchFile(
      testDb.db,
      creator.auth,
      { launchId, uploadKey: key, filename: "Guide.pdf" },
      storage(),
    )
    await insertOrder(testDb.db, launchId, NOW)
    await expect(
      removeLaunchFile(testDb.db, creator.auth, { launchId, fileId }, storage()),
    ).rejects.toThrow(LAUNCH_ERRORS.fileSold)
    const setup = await loadLaunchSetup(testDb.db, (await launchRow(testDb.db, launchId)).collabId)
    expect(setup?.files).toHaveLength(1)
  })

  it("refuses another user's upload and a file whose bytes are not the declared type", async () => {
    const { creator, builder, launchId } = await startedLaunch()
    await saveLaunch(testDb.db, creator.auth, {
      launchId,
      fields: completeFields({ deliveryType: "file" }),
    })
    const theirs = await upload(builder.user.id, "deliverable", "application/pdf", "%PDF")
    await expect(
      addLaunchFile(
        testDb.db,
        creator.auth,
        { launchId, uploadKey: theirs, filename: "x.pdf" },
        storage(),
      ),
    ).rejects.toThrow("Upload the file again")
    const key = await upload(creator.user.id, "media", "image/png", "png")
    // Stored as text/html: refused after the copy.
    await storage().putObject(key, "<html>", "text/html")
    await expect(
      addLaunchMedia(testDb.db, creator.auth, { launchId, uploadKey: key, alt: null }, storage()),
    ).rejects.toThrow()
    expect((await launchRow(testDb.db, launchId)).media).toEqual([])
  })

  it("adds license keys while live without resetting approvals, deduplicated", async () => {
    stubServiceEnv({ AUTO_APPROVE_LAUNCHES: "true" })
    const { creator, builder, launchId } = await startedLaunch()
    await saveLaunch(testDb.db, creator.auth, {
      launchId,
      fields: completeFields({
        deliveryType: "license_key",
        instructions: "Enter it in Settings.",
      }),
    })
    await addLicenseKeys(testDb.db, builder.auth, { launchId, text: "A-1\nA-2" })
    await approveLaunch(testDb.db, creator.auth, { launchId })
    await approveLaunch(testDb.db, builder.auth, { launchId })
    expect((await launchRow(testDb.db, launchId)).status).toBe("live")
    const result = await addLicenseKeys(testDb.db, creator.auth, {
      launchId,
      text: "A-2\nA-3\nA-3",
    })
    expect(result).toMatchObject({ added: 1, alreadyThere: 1, duplicates: 1 })
    const row = await launchRow(testDb.db, launchId)
    expect(row.status).toBe("live")
    expect(row.approvedBy).toHaveLength(2)
    const keys = await testDb.db
      .select()
      .from(licenseKeys)
      .where(eq(licenseKeys.launchId, launchId))
    expect(keys.map((k) => k.key).sort()).toEqual(["A-1", "A-2", "A-3"])
    expect(row.deliveryConfig).toEqual({
      type: "license_key",
      instructions: "Enter it in Settings.",
    })
  })
})

describe("actions", () => {
  it("returns field errors and plain refusals; strangers learn nothing", async () => {
    const { creator, launchId, collab } = await startedLaunch()
    mocks.user = creator.auth
    const bad = await saveLaunchAction({
      launchId,
      title: "",
      slug: "x",
      price: "0.10",
      deliveryType: "url",
      deliveryUrl: "http://insecure.example.com",
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(Object.keys(bad.fieldErrors ?? {}).sort()).toEqual(
        ["deliveryUrl", "price", "slug", "title"].sort(),
      )
    }
    const other = await startedLaunch()
    const taken = await saveLaunchAction({
      launchId,
      title: "Meal planner",
      slug: (await launchRow(testDb.db, other.launchId)).slug,
      price: "19",
      deliveryType: "url",
      deliveryUrl: "app.example.com/welcome",
    })
    expect(taken.ok).toBe(false)
    if (!taken.ok) expect(taken.fieldErrors?.slug).toEqual([LAUNCH_ERRORS.slugTaken])

    mocks.user = await strangerUser(testDb.db)
    const refused = await approveLaunchAction({ launchId })
    expect(refused).toMatchObject({ ok: false, error: LAUNCH_ERRORS.notFound })
    const notStarted = await createLaunchAction({ collabId: collab.id })
    expect(notStarted).toMatchObject({ ok: false, error: LAUNCH_ERRORS.collabNotFound })

    mocks.user = await adminUser(testDb.db)
    const notInReview = await adminRejectLaunchAction({ launchId, note: "Fix it" })
    expect(notInReview).toMatchObject({ ok: false, error: LAUNCH_ERRORS.notInReview })
    const [stillDraft] = await testDb.db.select().from(launches).where(eq(launches.id, launchId))
    expect(stillDraft?.status).toBe("draft")
  })
})
