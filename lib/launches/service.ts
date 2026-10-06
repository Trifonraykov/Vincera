import "server-only"

import { and, eq, inArray, ne } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import {
  canApproveLaunch,
  canEditLaunch,
  canEndLaunch,
  canPauseLaunch,
  canResumeLaunch,
  canReviewLaunch,
  canWorkInCollab,
  isAdmin,
  type AuthzUser,
  type LaunchAccess,
} from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { changeCollabStage } from "@/lib/collabs/stage"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { isPgError, PG_ERROR } from "@/lib/db/errors"
import {
  adminAuditLog,
  collabMembers,
  collabs,
  ideas,
  launches,
  orders,
  products,
  type AuditSnapshot,
  type CollabRole,
  type CollabStage,
  type LaunchApproval,
  type LaunchPausedBy,
  type LaunchStatus,
} from "@/lib/db/schema"
import { requestEmbeddingRefreshAfterCommit } from "@/lib/embeddings/request"
import { env } from "@/lib/env"
import { track } from "@/lib/events/track"
import { DEFAULT_TAX_CODES } from "@/lib/stripe/checkout-shared"

import {
  baseSlug,
  deliveryConfigFor,
  joinList,
  LAUNCH_CURRENCY,
  LAUNCH_TITLE_MAX,
  missingForApproval,
  parseDeliveryConfig,
  slugCandidates,
  type LaunchFields,
} from "./fields"
import {
  notifyApprovalRequested,
  notifyLaunchLive,
  notifyLaunchPaused,
  notifyLaunchRejected,
  notifyReviewRequested,
} from "./notifications"
import {
  adminUserIds,
  loadCollabTarget,
  loadContentCounts,
  loadLaunchMembers,
  memberApprovals,
  type LaunchRow,
} from "./queries"
import { revalidateLaunchPage } from "./revalidate"
import { collabStageForLaunch, launchStatusAfter } from "./status"
import { ensureDefaultTrackedLink } from "./tracked-links"

/**
 * The launch lifecycle (§12 "Launch setup page", CLAUDE.md §19.31 "Launch status machine",
 * §19.32). Every change runs in one transaction that locks the launch row (`FOR UPDATE`), checks
 * the rule from lib/auth/authz.ts again under the lock, writes the change, keeps the collab's
 * stage in step (`collabStageForLaunch` → `changeCollabStage`), emits its events, and notifies
 * last. After the commit the public page `/p/<slug>` is revalidated when it shows the change.
 *
 * Refusals are plain-language `ActionError`s; people outside the collab get "not found".
 */

export const LAUNCH_ERRORS = {
  notFound: "We couldn't find that launch.",
  collabNotFound: "We couldn't find that collab.",
  notBuilding:
    "The launch can be set up once you've both signed the agreement and the collab is building.",
  ended: "This launch has ended, so it can't change any more.",
  collabEnded: "This collab has ended, so its launch can't change any more.",
  live: "Pause sales first, then change the launch.",
  notEditable: "This launch can't be changed right now.",
  alreadyApproved: "You've already approved this version.",
  notApprovable: "This launch can't be approved right now.",
  notInReview: "This launch isn't waiting for review any more.",
  notLive: "Only a live launch can be paused.",
  notPaused: "This launch isn't paused.",
  resumeNeedsApprovals:
    "Both members need to approve the current version before sales start again.",
  resumeAdminOnly: "Our team paused this launch. Contact support to start sales again.",
  slugTaken: "That link is taken. Try another one.",
  slugFixed: "The link can't change once the launch has gone live.",
  deliveryFixed:
    "People have already bought this launch, so how it's delivered can't change. Contact support if it must.",
  urlFixed:
    "People have already bought this launch and use this link, so it can't change. Contact support if it must.",
  fileSold:
    "People have already bought this launch, so its files can't be removed. You can add new ones.",
} as const

// --- Locking --------------------------------------------------------------------------------

export type LockedLaunch = {
  row: LaunchRow
  collabStage: CollabStage
  members: { userId: string; role: CollabRole }[]
  approvals: LaunchApproval[]
  access: LaunchAccess & { approvedUserIds: string[]; pausedBy: LaunchPausedBy | null }
}

export async function lockLaunch(tx: Tx, launchId: string): Promise<LockedLaunch | null> {
  const [found] = await tx
    .select({ launch: launches, collabStage: collabs.stage })
    .from(launches)
    .innerJoin(collabs, eq(collabs.id, launches.collabId))
    .where(eq(launches.id, launchId))
    .for("update", { of: launches })
  if (!found) return null
  const members = await tx
    .select({ userId: collabMembers.userId, role: collabMembers.role })
    .from(collabMembers)
    .where(eq(collabMembers.collabId, found.launch.collabId))
  const approvals = Array.isArray(found.launch.approvedBy) ? found.launch.approvedBy : []
  return {
    row: found.launch,
    collabStage: found.collabStage,
    members,
    approvals,
    access: {
      status: found.launch.status,
      collabStage: found.collabStage,
      memberUserIds: members.map((member) => member.userId),
      approvedUserIds: memberApprovals(approvals),
      pausedBy: found.launch.pausedBy,
    },
  }
}

/** Lock for a member's action: strangers (admins included) learn nothing. */
async function lockForMember(tx: Tx, user: AuthzUser, launchId: string): Promise<LockedLaunch> {
  const state = await lockLaunch(tx, launchId)
  if (!state || !state.access.memberUserIds.includes(user.id)) {
    throw new ActionError(LAUNCH_ERRORS.notFound)
  }
  return state
}

function refuseEdit(state: LockedLaunch): never {
  if (state.row.status === "ended") throw new ActionError(LAUNCH_ERRORS.ended)
  if (state.collabStage === "ended") throw new ActionError(LAUNCH_ERRORS.collabEnded)
  if (state.row.status === "live") throw new ActionError(LAUNCH_ERRORS.live)
  throw new ActionError(LAUNCH_ERRORS.notEditable)
}

/** Lock and check `canEditLaunch` (setup fields, files, images). */
export async function lockForEdit(
  tx: Tx,
  user: AuthzUser,
  launchId: string,
): Promise<LockedLaunch> {
  const state = await lockForMember(tx, user, launchId)
  if (!canEditLaunch(user, state.access)) refuseEdit(state)
  return state
}

// --- Shared steps ---------------------------------------------------------------------------

function roleOf(state: LockedLaunch, userId: string): CollabRole {
  return state.members.find((member) => member.userId === userId)?.role ?? "creator"
}

/** Move the collab's stage with the launch's new status (CLAUDE.md §19.31). */
async function syncCollabStage(
  tx: Tx,
  state: LockedLaunch,
  status: LaunchStatus,
  actorUserId: string | null,
): Promise<void> {
  const to = collabStageForLaunch(state.collabStage, status)
  if (!to) return
  await changeCollabStage(tx, {
    collabId: state.row.collabId,
    from: state.collabStage,
    to,
    actorUserId,
  })
  state.collabStage = to
}

async function audit(
  tx: Tx,
  admin: AuthzUser,
  action: string,
  launchId: string,
  before: AuditSnapshot,
  after: AuditSnapshot,
): Promise<void> {
  await tx.insert(adminAuditLog).values({
    adminUserId: admin.id,
    action,
    targetType: "launch",
    targetId: launchId,
    before,
    after,
  })
}

/**
 * Whether anyone bought the launch. Past buyers' access reads the launch's current delivery
 * (`/access/<token>`), so once there are orders the delivery type, a URL delivery's target and the
 * deliverable files stay as sold (CLAUDE.md §19.37): files can be added, never removed.
 */
export async function launchHasOrders(tx: DbOrTx, launchId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.launchId, launchId))
    .limit(1)
  return row !== undefined
}

/**
 * A member changed the launch (fields, files or images): approvals of the previous version no
 * longer count (§12 "saving resets approvals"); `pending_approval` / `admin_review` go back to
 * `draft` (and the collab back to `building`). A `paused` launch goes back to `draft` too, so the
 * changed version passes admin review before it sells again (§12, CLAUDE.md §19.37); only with
 * `AUTO_APPROVE_LAUNCHES` does it stay paused (both approvals then re-arm "Resume").
 */
export async function recordEdit(
  tx: Tx,
  state: LockedLaunch,
  user: AuthzUser,
  input: { fields: string[]; set?: Partial<typeof launches.$inferInsert> },
  options: { autoApprove?: boolean } = {},
): Promise<{ status: LaunchStatus; approvalsReset: boolean }> {
  const autoApprove = options.autoApprove ?? env.AUTO_APPROVE_LAUNCHES
  const status = launchStatusAfter(state.row.status, "save", { autoApprove })
  if (!status) refuseEdit(state)
  const approvalsReset = state.approvals.length > 0 || status !== state.row.status
  await tx
    .update(launches)
    .set({
      ...input.set,
      status,
      approvedBy: [],
      ...(status === "draft" ? { submittedAt: null, pausedAt: null, pausedBy: null } : {}),
    })
    .where(eq(launches.id, state.row.id))
  await syncCollabStage(tx, state, status, user.id)
  await track(
    "launch.updated",
    {
      actorUserId: user.id,
      subjectType: "launch",
      subjectId: state.row.id,
      properties: {
        collab_id: state.row.collabId,
        fields: input.fields,
        approvals_reset: approvalsReset,
      },
    },
    tx,
  )
  state.row = {
    ...state.row,
    ...input.set,
    status,
    approvedBy: [],
    ...(status === "draft" ? { submittedAt: null, pausedAt: null, pausedBy: null } : {}),
  }
  state.approvals = []
  state.access = { ...state.access, status, approvedUserIds: [], pausedBy: state.row.pausedBy }
  return { status, approvalsReset }
}

/** Throws a plain-language error naming what is missing before approval. */
async function assertComplete(tx: Tx, state: LockedLaunch): Promise<void> {
  const counts = await loadContentCounts(tx, state.row.id)
  const missing = missingForApproval({
    title: state.row.title,
    priceCents: state.row.priceCents,
    deliveryType: state.row.deliveryType,
    deliveryConfig: parseDeliveryConfig(state.row.deliveryConfig),
    ...counts,
  })
  if (missing.length > 0) {
    throw new ActionError(`Before approving, add ${joinList(missing)}.`)
  }
}

async function launchMemberNames(tx: Tx, collabId: string): Promise<Map<string, string>> {
  const members = await loadLaunchMembers(tx, collabId)
  return new Map(members.map((member) => [member.userId, member.name]))
}

/**
 * The launch's first go-live (both approvals with `AUTO_APPROVE_LAUNCHES`, or an admin's approval):
 * status `live` and `went_live_at`, `launch.live`, the creator's default tracked link, the idea
 * (and an exclusive product) `in_collab → launched`, the collab → `live`, and `launch.live` to
 * both members. Runs inside the caller's transaction, under the launch lock.
 */
async function goLive(
  tx: Tx,
  state: LockedLaunch,
  input: {
    actorUserId: string | null
    autoApproved: boolean
    at: Date
    extra?: Partial<typeof launches.$inferInsert>
  },
): Promise<void> {
  const firstTime = state.row.wentLiveAt === null
  const wentLiveAt = state.row.wentLiveAt ?? input.at
  await tx
    .update(launches)
    .set({ ...input.extra, status: "live", wentLiveAt, pausedAt: null, pausedBy: null })
    .where(eq(launches.id, state.row.id))
  state.row = { ...state.row, ...input.extra, status: "live", wentLiveAt }
  await track(
    "launch.live",
    {
      actorUserId: input.actorUserId,
      subjectType: "launch",
      subjectId: state.row.id,
      properties: {
        collab_id: state.row.collabId,
        price_cents: state.row.priceCents ?? 0,
        currency: state.row.currency,
        auto_approved: input.autoApproved,
      },
    },
    tx,
  )
  await syncCollabStage(tx, state, "live", input.actorUserId)
  if (!firstTime) return

  const creator = state.members.find((member) => member.role === "creator")
  if (creator) {
    await ensureDefaultTrackedLink(tx, {
      launchId: state.row.id,
      ownerUserId: creator.userId,
      actorUserId: input.actorUserId,
    })
  }
  const target = await loadCollabTarget(tx, state.row.collabId)
  if (target.ideaId) {
    await tx
      .update(ideas)
      .set({ status: "launched" })
      .where(and(eq(ideas.id, target.ideaId), eq(ideas.status, "in_collab")))
  }
  // A non-exclusive product keeps `seeking`: it may launch with other creators (§19.24).
  if (target.productId && target.exclusive) {
    await tx
      .update(products)
      .set({ status: "launched" })
      .where(and(eq(products.id, target.productId), eq(products.status, "in_collab")))
  }
  for (const member of state.members) {
    await notifyLaunchLive(tx, {
      userId: member.userId,
      collabId: state.row.collabId,
      launchId: state.row.id,
      launchTitle: state.row.title,
      slug: state.row.slug,
      isCreator: member.role === "creator",
    })
  }
}

/** After a commit: the target left matching's candidates; the public page changed. */
async function afterGoLive(database: DbOrTx, launch: { collabId: string; slug: string }) {
  revalidateLaunchPage(launch.slug)
  const target = await loadCollabTarget(database, launch.collabId)
  if (target.ideaId) await requestEmbeddingRefreshAfterCommit({ type: "idea", id: target.ideaId })
  if (target.productId && target.exclusive) {
    await requestEmbeddingRefreshAfterCommit({ type: "product", id: target.productId })
  }
}

// --- Create ---------------------------------------------------------------------------------

async function freeSlug(tx: Tx, title: string): Promise<string> {
  const candidates = slugCandidates(baseSlug(title))
  const taken = await tx
    .select({ slug: launches.slug })
    .from(launches)
    .where(inArray(launches.slug, candidates))
  const used = new Set(taken.map((row) => row.slug))
  const free = candidates.find((candidate) => !used.has(candidate))
  if (free) return free
  return `${candidates[0]?.slice(0, 60) ?? "launch"}-${Date.parse(now().toISOString()).toString(36)}`
}

/**
 * Start the collab's launch (CLAUDE.md §19.31: "A collab in `building` gets one launch"): a draft
 * titled after the idea or product, with a free slug made from the title. Idempotent: an existing
 * launch is returned.
 */
export async function createLaunch(
  database: DbOrTx,
  user: AuthzUser,
  input: { collabId: string },
): Promise<{ launchId: string; created: boolean }> {
  return withTransaction(async (tx) => {
    const [collab] = await tx
      .select({
        id: collabs.id,
        stage: collabs.stage,
        ideaTitle: ideas.title,
        productTitle: products.title,
      })
      .from(collabs)
      .leftJoin(ideas, eq(ideas.id, collabs.ideaId))
      .leftJoin(products, eq(products.id, collabs.productId))
      .where(eq(collabs.id, input.collabId))
      .for("no key update", { of: collabs })
    if (!collab) throw new ActionError(LAUNCH_ERRORS.collabNotFound)
    const members = await tx
      .select({ userId: collabMembers.userId })
      .from(collabMembers)
      .where(eq(collabMembers.collabId, collab.id))
    const memberUserIds = members.map((member) => member.userId)
    if (!memberUserIds.includes(user.id)) throw new ActionError(LAUNCH_ERRORS.collabNotFound)
    const [existing] = await tx
      .select({ id: launches.id })
      .from(launches)
      .where(eq(launches.collabId, collab.id))
    if (existing) return { launchId: existing.id, created: false }
    if (!canWorkInCollab(user, { memberUserIds, stage: collab.stage })) {
      throw new ActionError(LAUNCH_ERRORS.collabEnded)
    }
    if (collab.stage !== "building") throw new ActionError(LAUNCH_ERRORS.notBuilding)

    const title = (collab.ideaTitle ?? collab.productTitle ?? "Untitled launch").slice(
      0,
      LAUNCH_TITLE_MAX,
    )
    const [launch] = await tx
      .insert(launches)
      .values({
        collabId: collab.id,
        slug: await freeSlug(tx, title),
        title,
        currency: LAUNCH_CURRENCY,
      })
      .returning({ id: launches.id })
    if (!launch) throw new Error("createLaunch: no row")
    await track(
      "launch.created",
      {
        actorUserId: user.id,
        subjectType: "launch",
        subjectId: launch.id,
        properties: { collab_id: collab.id },
      },
      tx,
    )
    return { launchId: launch.id, created: true }
  }, database)
}

// --- Save -----------------------------------------------------------------------------------

/** JSON with sorted object keys: jsonb hands objects back in its own key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  )
}

/** Refuse a delivery change that would change what past buyers get (`launchHasOrders`). */
async function assertDeliveryKept(
  tx: Tx,
  row: LaunchRow,
  deliveryType: LaunchFields["deliveryType"],
  deliveryConfig: ReturnType<typeof deliveryConfigFor>,
): Promise<void> {
  const before = parseDeliveryConfig(row.deliveryConfig)
  const typeChanged = deliveryType !== row.deliveryType
  const urlChanged =
    !typeChanged &&
    before?.type === "url" &&
    (deliveryConfig?.type !== "url" || deliveryConfig.url !== before.url)
  if (!typeChanged && !urlChanged) return
  if (!(await launchHasOrders(tx, row.id))) return
  if (typeChanged) {
    throw new ActionError(LAUNCH_ERRORS.deliveryFixed, {
      fieldErrors: { deliveryType: [LAUNCH_ERRORS.deliveryFixed] },
    })
  }
  throw new ActionError(LAUNCH_ERRORS.urlFixed, {
    fieldErrors: { deliveryUrl: [LAUNCH_ERRORS.urlFixed] },
  })
}

export type SaveLaunchResult = {
  changed: string[]
  status: LaunchStatus
  approvalsReset: boolean
  slug: string
}

/**
 * Save the setup form (§12: either member edits; saving resets approvals). Only changed columns
 * count; a save that changes nothing resets nothing. The slug is fixed once the launch went live.
 */
export async function saveLaunch(
  database: DbOrTx,
  user: AuthzUser,
  input: { launchId: string; fields: LaunchFields },
  options: { autoApprove?: boolean } = {},
): Promise<SaveLaunchResult> {
  const { fields } = input
  let previousPublicSlug: string | null = null
  const result = await withTransaction(async (tx) => {
    const state = await lockForEdit(tx, user, input.launchId)
    const row = state.row
    if (fields.slug !== row.slug && row.wentLiveAt) {
      throw new ActionError(LAUNCH_ERRORS.slugFixed, {
        fieldErrors: { slug: [LAUNCH_ERRORS.slugFixed] },
      })
    }
    if (fields.slug !== row.slug) {
      const [taken] = await tx
        .select({ id: launches.id })
        .from(launches)
        .where(and(eq(launches.slug, fields.slug), ne(launches.id, row.id)))
      if (taken) {
        throw new ActionError(LAUNCH_ERRORS.slugTaken, {
          fieldErrors: { slug: [LAUNCH_ERRORS.slugTaken] },
        })
      }
    }
    const deliveryConfig = deliveryConfigFor(fields)
    const next = {
      title: fields.title,
      tagline: fields.tagline,
      descriptionMd: fields.descriptionMd,
      priceCents: fields.price,
      slug: fields.slug,
      deliveryType: fields.deliveryType,
      deliveryConfig,
      taxCode: fields.deliveryType ? DEFAULT_TAX_CODES[fields.deliveryType] : null,
    }
    const columns: Record<keyof typeof next, string> = {
      title: "title",
      tagline: "tagline",
      descriptionMd: "description_md",
      priceCents: "price_cents",
      slug: "slug",
      deliveryType: "delivery_type",
      deliveryConfig: "delivery_config",
      taxCode: "tax_code",
    }
    const changed = (Object.keys(next) as (keyof typeof next)[])
      .filter((key) => stableJson(next[key]) !== stableJson(row[key] ?? null))
      .map((key) => columns[key])
    if (changed.length === 0) {
      return { changed, status: row.status, approvalsReset: false, slug: row.slug }
    }
    if (changed.includes("delivery_type") || changed.includes("delivery_config")) {
      await assertDeliveryKept(tx, row, next.deliveryType, deliveryConfig)
    }
    if (row.wentLiveAt) previousPublicSlug = row.slug
    const edit = await recordEdit(tx, state, user, { fields: changed, set: next }, options)
    return { changed, ...edit, slug: fields.slug }
  }, database).catch((error: unknown) => {
    if (isPgError(error, PG_ERROR.uniqueViolation, "launches_slug_unique")) {
      throw new ActionError(LAUNCH_ERRORS.slugTaken, {
        fieldErrors: { slug: [LAUNCH_ERRORS.slugTaken] },
      })
    }
    throw error
  })
  if (previousPublicSlug) revalidateLaunchPage(previousPublicSlug)
  return result
}

// --- Approve --------------------------------------------------------------------------------

export type ApproveResult = { status: LaunchStatus; allApproved: boolean }

/**
 * A member approves the current version (`launch.approved`). The first approval submits it
 * (`draft → pending_approval`, `launch.submitted`, the other member is asked); the second sends it
 * to `admin_review` (admins are told) or, with `AUTO_APPROVE_LAUNCHES`, live. On a paused launch
 * approvals only re-arm "Resume".
 */
export async function approveLaunch(
  database: DbOrTx,
  user: AuthzUser,
  input: { launchId: string },
  options: { autoApprove?: boolean } = {},
): Promise<ApproveResult> {
  const autoApprove = options.autoApprove ?? env.AUTO_APPROVE_LAUNCHES
  let wentLive: { collabId: string; slug: string } | null = null
  const result = await withTransaction(async (tx) => {
    const state = await lockForMember(tx, user, input.launchId)
    if (!canApproveLaunch(user, state.access)) {
      if (state.access.approvedUserIds.includes(user.id)) {
        throw new ActionError(LAUNCH_ERRORS.alreadyApproved)
      }
      if (state.row.status === "ended") throw new ActionError(LAUNCH_ERRORS.ended)
      if (state.collabStage === "ended") throw new ActionError(LAUNCH_ERRORS.collabEnded)
      throw new ActionError(LAUNCH_ERRORS.notApprovable)
    }
    await assertComplete(tx, state)

    const at = now()
    const role = roleOf(state, user.id)
    const approvals: LaunchApproval[] = [
      ...state.approvals,
      { userId: user.id, role, approvedAt: at.toISOString() },
    ]
    const approved = new Set(memberApprovals(approvals))
    const allMembersApproved = state.members.every((member) => approved.has(member.userId))
    const from = state.row.status
    const status = launchStatusAfter(from, "approve", { allMembersApproved, autoApprove })
    if (!status) throw new ActionError(LAUNCH_ERRORS.notApprovable)

    const submitted = from === "draft"
    const submittedAt = submitted ? at : (state.row.submittedAt ?? at)
    await tx
      .update(launches)
      .set({
        approvedBy: approvals,
        ...(from !== "paused" ? { submittedAt } : {}),
        ...(submitted ? { reviewNote: null } : {}),
        // Going live happens in `goLive` below, from `pending_approval` (which needs
        // `submitted_at`), so the collab passes through `launch_review` first.
        status: status === "live" ? "pending_approval" : status,
      })
      .where(eq(launches.id, state.row.id))
    state.row = { ...state.row, approvedBy: approvals, submittedAt }
    state.approvals = approvals

    const base = { actorUserId: user.id, subjectType: "launch" as const, subjectId: state.row.id }
    await track(
      "launch.approved",
      { ...base, properties: { collab_id: state.row.collabId, role } },
      tx,
    )
    if (submitted) {
      await track(
        "launch.submitted",
        {
          ...base,
          properties: {
            collab_id: state.row.collabId,
            price_cents: state.row.priceCents ?? 0,
            currency: state.row.currency,
            delivery_type: state.row.deliveryType ?? "url",
          },
        },
        tx,
      )
    }
    if (status === "paused") return { status, allApproved: allMembersApproved }

    // The collab enters `launch_review` with the first approval.
    await syncCollabStage(tx, state, status === "live" ? "pending_approval" : status, user.id)

    if (status === "live") {
      await goLive(tx, state, { actorUserId: user.id, autoApproved: true, at })
      wentLive = { collabId: state.row.collabId, slug: state.row.slug }
    } else if (status === "admin_review") {
      for (const adminId of await adminUserIds(tx)) {
        await notifyReviewRequested(tx, {
          userId: adminId,
          collabId: state.row.collabId,
          launchId: state.row.id,
          launchTitle: state.row.title,
          submittedAt,
        })
      }
    } else if (!allMembersApproved) {
      const names = await launchMemberNames(tx, state.row.collabId)
      for (const member of state.members) {
        if (approved.has(member.userId)) continue
        await notifyApprovalRequested(tx, {
          userId: member.userId,
          collabId: state.row.collabId,
          launchId: state.row.id,
          launchTitle: state.row.title,
          approverName: names.get(user.id) ?? "Your collaborator",
          submittedAt,
        })
      }
    }
    return { status, allApproved: allMembersApproved }
  }, database)
  if (wentLive) await afterGoLive(database, wentLive)
  return result
}

// --- Admin review ---------------------------------------------------------------------------

async function lockForAdmin(tx: Tx, admin: AuthzUser, launchId: string): Promise<LockedLaunch> {
  if (!isAdmin(admin)) throw new ActionError(LAUNCH_ERRORS.notFound)
  const state = await lockLaunch(tx, launchId)
  if (!state) throw new ActionError(LAUNCH_ERRORS.notFound)
  return state
}

/** An admin approves a launch in `admin_review`: it goes live (audited). */
export async function adminApproveLaunch(
  database: DbOrTx,
  admin: AuthzUser,
  input: { launchId: string },
): Promise<{ status: LaunchStatus }> {
  const launch = await withTransaction(async (tx) => {
    const state = await lockForAdmin(tx, admin, input.launchId)
    if (!canReviewLaunch(admin, state.row)) throw new ActionError(LAUNCH_ERRORS.notInReview)
    const at = now()
    const approvals: LaunchApproval[] = [
      ...state.approvals,
      { userId: admin.id, role: "admin", approvedAt: at.toISOString() },
    ]
    await track(
      "launch.approved",
      {
        actorUserId: admin.id,
        subjectType: "launch",
        subjectId: state.row.id,
        properties: { collab_id: state.row.collabId, role: "admin" },
      },
      tx,
    )
    await goLive(tx, state, {
      actorUserId: admin.id,
      autoApproved: false,
      at,
      extra: {
        approvedBy: approvals,
        reviewedByUserId: admin.id,
        reviewedAt: at,
        reviewNote: null,
      },
    })
    await audit(
      tx,
      admin,
      "launch.approved",
      state.row.id,
      { status: "admin_review" },
      {
        status: "live",
        collab_id: state.row.collabId,
      },
    )
    return { collabId: state.row.collabId, slug: state.row.slug }
  }, database)
  await afterGoLive(database, launch)
  return { status: "live" }
}

/** An admin sends a launch in `admin_review` back to draft with a note (audited). */
export async function adminRejectLaunch(
  database: DbOrTx,
  admin: AuthzUser,
  input: { launchId: string; note: string },
): Promise<{ status: LaunchStatus }> {
  return withTransaction(async (tx) => {
    const state = await lockForAdmin(tx, admin, input.launchId)
    if (!canReviewLaunch(admin, state.row)) throw new ActionError(LAUNCH_ERRORS.notInReview)
    const status = launchStatusAfter(state.row.status, "admin_reject")
    if (status !== "draft") throw new ActionError(LAUNCH_ERRORS.notInReview)
    const at = now()
    await tx
      .update(launches)
      .set({
        status,
        approvedBy: [],
        submittedAt: null,
        reviewNote: input.note,
        reviewedByUserId: admin.id,
        reviewedAt: at,
      })
      .where(eq(launches.id, state.row.id))
    await syncCollabStage(tx, state, status, admin.id)
    await track(
      "launch.rejected",
      {
        actorUserId: admin.id,
        subjectType: "launch",
        subjectId: state.row.id,
        properties: { collab_id: state.row.collabId },
      },
      tx,
    )
    await audit(
      tx,
      admin,
      "launch.rejected",
      state.row.id,
      { status: "admin_review" },
      {
        status,
        review_note: input.note,
      },
    )
    for (const member of state.members) {
      await notifyLaunchRejected(tx, {
        userId: member.userId,
        collabId: state.row.collabId,
        launchId: state.row.id,
        launchTitle: state.row.title,
        note: input.note,
        reviewedAt: at,
      })
    }
    return { status }
  }, database)
}

// --- Pause, resume, end ---------------------------------------------------------------------

/** A member or an admin pauses a live launch (the product page then says "unavailable"). */
export async function pauseLaunch(
  database: DbOrTx,
  user: AuthzUser,
  input: { launchId: string },
): Promise<{ status: LaunchStatus }> {
  const slug = await withTransaction(async (tx) => {
    const state = isAdmin(user)
      ? await lockForAdmin(tx, user, input.launchId)
      : await lockForMember(tx, user, input.launchId)
    if (!canPauseLaunch(user, state.access)) throw new ActionError(LAUNCH_ERRORS.notLive)
    const by: LaunchPausedBy = state.access.memberUserIds.includes(user.id) ? "member" : "admin"
    const at = now()
    await tx
      .update(launches)
      .set({ status: "paused", pausedAt: at, pausedBy: by })
      .where(eq(launches.id, state.row.id))
    await track(
      "launch.paused",
      {
        actorUserId: user.id,
        subjectType: "launch",
        subjectId: state.row.id,
        properties: { collab_id: state.row.collabId, by },
      },
      tx,
    )
    if (by === "admin") {
      await audit(tx, user, "launch.paused", state.row.id, { status: "live" }, { status: "paused" })
    }
    for (const member of state.members) {
      if (member.userId === user.id) continue
      await notifyLaunchPaused(tx, {
        userId: member.userId,
        collabId: state.row.collabId,
        launchId: state.row.id,
        launchTitle: state.row.title,
        pausedBy: by,
        pausedAt: at,
      })
    }
    return state.row.slug
  }, database)
  revalidateLaunchPage(slug)
  return { status: "paused" }
}

/**
 * Resume a paused launch, once both members approved the current version (an edit while paused
 * resets approvals). Paused by a member: a member or an admin resumes; paused by an admin or a
 * dispute: an admin only.
 */
export async function resumeLaunch(
  database: DbOrTx,
  user: AuthzUser,
  input: { launchId: string },
): Promise<{ status: LaunchStatus }> {
  const slug = await withTransaction(async (tx) => {
    const state = isAdmin(user)
      ? await lockForAdmin(tx, user, input.launchId)
      : await lockForMember(tx, user, input.launchId)
    if (state.row.status !== "paused") throw new ActionError(LAUNCH_ERRORS.notPaused)
    if (!canResumeLaunch(user, state.access)) {
      if (state.collabStage === "ended") throw new ActionError(LAUNCH_ERRORS.collabEnded)
      throw new ActionError(LAUNCH_ERRORS.resumeAdminOnly)
    }
    const approved = new Set(state.access.approvedUserIds)
    // Whoever paused it, an edit made while paused reset the approvals: both members approve the
    // current version before it sells again (an admin resume never skips that).
    if (!state.members.every((member) => approved.has(member.userId))) {
      throw new ActionError(LAUNCH_ERRORS.resumeNeedsApprovals)
    }
    await assertComplete(tx, state)
    const byAdmin = !state.access.memberUserIds.includes(user.id)
    await tx
      .update(launches)
      .set({ status: "live", pausedAt: null, pausedBy: null })
      .where(eq(launches.id, state.row.id))
    await track(
      "launch.resumed",
      {
        actorUserId: user.id,
        subjectType: "launch",
        subjectId: state.row.id,
        properties: { collab_id: state.row.collabId, by: byAdmin ? "admin" : "member" },
      },
      tx,
    )
    if (byAdmin) {
      await audit(
        tx,
        user,
        "launch.resumed",
        state.row.id,
        {
          status: "paused",
          paused_by: state.row.pausedBy,
        },
        { status: "live" },
      )
    }
    return state.row.slug
  }, database)
  revalidateLaunchPage(slug)
  return { status: "live" }
}

/**
 * End sales for good (in the caller's transaction): status `ended`, `launch.ended { by }`.
 * Buyers keep their access. Phase 6 calls it with `by: "collab_ended"` when a collab ends.
 */
export async function endLaunchInTx(
  tx: Tx,
  state: LockedLaunch,
  input: { actorUserId: string | null; by: "admin" | "collab_ended" },
): Promise<void> {
  if (!launchStatusAfter(state.row.status, "end")) throw new ActionError(LAUNCH_ERRORS.ended)
  await tx
    .update(launches)
    .set({ status: "ended", endedAt: now(), pausedAt: null, pausedBy: null })
    .where(eq(launches.id, state.row.id))
  await track(
    "launch.ended",
    {
      actorUserId: input.actorUserId,
      subjectType: "launch",
      subjectId: state.row.id,
      properties: { collab_id: state.row.collabId, by: input.by },
    },
    tx,
  )
}

/** An admin ends a launch (audited). */
export async function endLaunch(
  database: DbOrTx,
  admin: AuthzUser,
  input: { launchId: string },
): Promise<{ status: LaunchStatus }> {
  const slug = await withTransaction(async (tx) => {
    const state = await lockForAdmin(tx, admin, input.launchId)
    if (!canEndLaunch(admin, state.row)) throw new ActionError(LAUNCH_ERRORS.ended)
    const before = state.row.status
    await endLaunchInTx(tx, state, { actorUserId: admin.id, by: "admin" })
    await audit(tx, admin, "launch.ended", state.row.id, { status: before }, { status: "ended" })
    return state.row.slug
  }, database)
  revalidateLaunchPage(slug)
  return { status: "ended" }
}
