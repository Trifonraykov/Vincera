import "server-only"

import { and, asc, desc, eq, isNull } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { generateLinkCode } from "@/lib/attribution/code"
import { canManageTrackedLink, type AuthzUser } from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { isPgError, PG_ERROR } from "@/lib/db/errors"
import { collabMembers, launches, trackedLinks } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { newId } from "@/lib/ids"
import { reportError } from "@/lib/observability"
import type { PromotionsGateway } from "@/lib/stripe/gateway"
import { StripeGatewayError } from "@/lib/stripe/shared"

import type { CreateLinkInput } from "./fields"

/**
 * Tracked links of a launch (§10; CLAUDE.md §19.38, `/app/launches/[id]/links`). Members of a
 * live or paused launch create links for themselves (`canCreateTrackedLink`, checked by the
 * action), optionally with a discount code; owners rename or turn off their own links
 * (`canManageTrackedLink`, checked here again under the row lock). The default link (made when
 * the launch went live) can be renamed but not turned off: the launch kit shares it.
 *
 * A discount code becomes a Stripe promotion code **before** the row is written, with the
 * contract's idempotency key `promo:<trackedLinkId>` (the id is chosen first), so a link never
 * claims a code Stripe refused. If the insert then fails, the promotion code is deactivated.
 */

export const LINK_ERRORS = {
  notFound: "This link doesn't exist or isn't yours.",
  launchNotOpen: "Links can be added while the launch is live or paused.",
  codeTaken: "That code is already used. Try another one.",
  stripe: "We couldn't set up the discount right now. Try again in a minute.",
  defaultLink: "The default link can't be turned off: the launch kit shares it.",
} as const

export type TrackedLinkItem = {
  id: string
  code: string
  label: string | null
  ownerUserId: string
  isDefault: boolean
  discountCode: string | null
  discountPercentOff: number | null
  disabledAt: Date | null
  createdAt: Date
}

export async function listLaunchLinks(
  database: DbOrTx,
  launchId: string,
): Promise<TrackedLinkItem[]> {
  return database
    .select({
      id: trackedLinks.id,
      code: trackedLinks.code,
      label: trackedLinks.label,
      ownerUserId: trackedLinks.ownerUserId,
      isDefault: trackedLinks.isDefault,
      discountCode: trackedLinks.discountCode,
      discountPercentOff: trackedLinks.discountPercentOff,
      disabledAt: trackedLinks.disabledAt,
      createdAt: trackedLinks.createdAt,
    })
    .from(trackedLinks)
    .where(eq(trackedLinks.launchId, launchId))
    .orderBy(desc(trackedLinks.isDefault), asc(trackedLinks.createdAt))
}

async function discountCodeTaken(database: DbOrTx, code: string): Promise<boolean> {
  const [row] = await database
    .select({ id: trackedLinks.id })
    .from(trackedLinks)
    .where(eq(trackedLinks.discountCode, code))
  return Boolean(row)
}

const CODE_ATTEMPTS = 5

export async function createTrackedLink(
  database: DbOrTx,
  input: CreateLinkInput & { ownerUserId: string },
  deps: { gateway: Pick<PromotionsGateway, "createPromotionCode" | "deactivatePromotionCode"> },
): Promise<{ id: string; code: string }> {
  const linkId = newId()
  let promotionCodeId: string | null = null
  if (input.discountCode && input.discountPercent !== undefined) {
    if (await discountCodeTaken(database, input.discountCode)) {
      throw new ActionError(LINK_ERRORS.codeTaken, {
        fieldErrors: { discountCode: [LINK_ERRORS.codeTaken] },
      })
    }
    try {
      const promotion = await deps.gateway.createPromotionCode(
        {
          code: input.discountCode,
          percentOff: input.discountPercent,
          metadata: { tracked_link_id: linkId, launch_id: input.launchId },
        },
        { idempotencyKey: `promo:${linkId}` },
      )
      promotionCodeId = promotion.id
    } catch (error) {
      if (error instanceof StripeGatewayError && error.code === "invalid_request") {
        // Stripe already has an active code with this text (another environment or the dashboard).
        throw new ActionError(LINK_ERRORS.codeTaken, {
          fieldErrors: { discountCode: [LINK_ERRORS.codeTaken] },
        })
      }
      reportError(error, { tags: { area: "tracked_links", step: "promotion_code" } })
      throw new ActionError(LINK_ERRORS.stripe)
    }
  }

  try {
    return await withTransaction(async (tx) => {
      const [launch] = await tx
        .select({ status: launches.status })
        .from(launches)
        .where(eq(launches.id, input.launchId))
        .for("share")
      if (!launch || (launch.status !== "live" && launch.status !== "paused")) {
        throw new ActionError(LINK_ERRORS.launchNotOpen)
      }
      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
        const [link] = await tx
          .insert(trackedLinks)
          .values({
            id: linkId,
            launchId: input.launchId,
            ownerUserId: input.ownerUserId,
            code: generateLinkCode(),
            label: input.label,
            discountCode: input.discountCode ?? null,
            discountPercentOff: input.discountCode ? (input.discountPercent ?? null) : null,
            stripePromotionCodeId: promotionCodeId,
          })
          .onConflictDoNothing({ target: trackedLinks.code })
          .returning({ id: trackedLinks.id, code: trackedLinks.code })
        if (!link) continue
        await track(
          "tracked_link.created",
          {
            actorUserId: input.ownerUserId,
            subjectType: "tracked_link",
            subjectId: link.id,
            properties: {
              launch_id: input.launchId,
              is_default: false,
              has_discount: Boolean(input.discountCode),
            },
          },
          tx,
        )
        return link
      }
      throw new Error("Could not find a free tracked link code")
    }, database)
  } catch (error) {
    if (promotionCodeId) {
      await deps.gateway.deactivatePromotionCode(promotionCodeId).catch((cleanup: unknown) => {
        reportError(cleanup, { tags: { area: "tracked_links", step: "promotion_cleanup" } })
      })
    }
    if (isPgError(error, PG_ERROR.uniqueViolation, "tracked_links_discount_code_unique")) {
      throw new ActionError(LINK_ERRORS.codeTaken, {
        fieldErrors: { discountCode: [LINK_ERRORS.codeTaken] },
      })
    }
    throw error
  }
}

/** Lock a link with what `canManageTrackedLink` needs; refuses anyone but its owner. */
async function lockOwnLink(tx: DbOrTx, user: AuthzUser, linkId: string) {
  const [link] = await tx
    .select()
    .from(trackedLinks)
    .where(eq(trackedLinks.id, linkId))
    .for("update")
  if (!link) throw new ActionError(LINK_ERRORS.notFound)
  const [launch] = await tx
    .select({ collabId: launches.collabId })
    .from(launches)
    .where(eq(launches.id, link.launchId))
  const members = launch
    ? await tx
        .select({ userId: collabMembers.userId })
        .from(collabMembers)
        .where(eq(collabMembers.collabId, launch.collabId))
    : []
  const allowed = canManageTrackedLink(user, {
    ownerUserId: link.ownerUserId,
    memberUserIds: members.map((member) => member.userId),
  })
  if (!allowed) throw new ActionError(LINK_ERRORS.notFound)
  return link
}

export async function renameTrackedLink(
  database: DbOrTx,
  user: AuthzUser,
  input: { linkId: string; label: string },
): Promise<{ changed: boolean; launchId: string }> {
  return withTransaction(async (tx) => {
    const link = await lockOwnLink(tx, user, input.linkId)
    if (link.label === input.label) return { changed: false, launchId: link.launchId }
    await tx.update(trackedLinks).set({ label: input.label }).where(eq(trackedLinks.id, link.id))
    await track(
      "tracked_link.updated",
      {
        actorUserId: user.id,
        subjectType: "tracked_link",
        subjectId: link.id,
        properties: { launch_id: link.launchId, fields: ["label"] },
      },
      tx,
    )
    return { changed: true, launchId: link.launchId }
  }, database)
}

/**
 * Turn a link off: it keeps redirecting (old posts still work) but stops attributing, and its
 * promotion code is deactivated at Stripe after the commit (a failure is reported; the code stays
 * usable at Stripe but no longer attributes, §19.32).
 */
export async function disableTrackedLink(
  database: DbOrTx,
  user: AuthzUser,
  input: { linkId: string },
  deps: { gateway: Pick<PromotionsGateway, "deactivatePromotionCode"> },
): Promise<{ changed: boolean; launchId: string }> {
  const result = await withTransaction(async (tx) => {
    const link = await lockOwnLink(tx, user, input.linkId)
    if (link.isDefault) throw new ActionError(LINK_ERRORS.defaultLink)
    if (link.disabledAt) return { changed: false, launchId: link.launchId, promotion: null }
    const [updated] = await tx
      .update(trackedLinks)
      .set({ disabledAt: now() })
      .where(and(eq(trackedLinks.id, link.id), isNull(trackedLinks.disabledAt)))
      .returning({ id: trackedLinks.id })
    if (!updated) return { changed: false, launchId: link.launchId, promotion: null }
    await track(
      "tracked_link.disabled",
      {
        actorUserId: user.id,
        subjectType: "tracked_link",
        subjectId: link.id,
        properties: { launch_id: link.launchId },
      },
      tx,
    )
    return { changed: true, launchId: link.launchId, promotion: link.stripePromotionCodeId }
  }, database)
  if (result.promotion) {
    try {
      await deps.gateway.deactivatePromotionCode(result.promotion)
    } catch (error) {
      reportError(error, { tags: { area: "tracked_links", step: "deactivate_promotion" } })
    }
  }
  return { changed: result.changed, launchId: result.launchId }
}
