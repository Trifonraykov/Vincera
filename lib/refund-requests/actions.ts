"use server"

import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { eq } from "drizzle-orm"
import { z } from "zod"

import { ActionError, defineAction, type ActionResult } from "@/lib/actions/define-action"
import { canDecideRefundRequest } from "@/lib/auth/authz"
import { getDb } from "@/lib/db/client"
import { refundRequests } from "@/lib/db/schema"
import { runInBackground } from "@/lib/jobs/background"
import { reportError } from "@/lib/observability"
import { clientIp, rateLimit } from "@/lib/ratelimit"
import { getStripeGateway } from "@/lib/stripe/gateway"

import {
  approveRefundRequestSchema,
  declineRefundRequestSchema,
  REFUND_REFUSAL_MESSAGES,
  refundRequestFormSchema,
} from "./fields"
import {
  approveRefundRequest,
  declineRefundRequest,
  notifyRefundRequested,
  REFUND_DECISION_ERRORS,
  submitRefundRequest,
} from "./service"

/**
 * Refund request actions (CLAUDE.md §19.38).
 *
 * `submitRefundRequestAction` is a **plain server action**, the documented exception to
 * `defineAction`: buyers have no account (like the product page's view beacon), and the access
 * token bound to the form is what proves the purchase. It validates with Zod and is rate limited
 * per IP (`refund-request`, 5 per hour) and per token (3 per day; a request is one per order
 * anyway, so this only caps refused retries).
 *
 * The admin actions use `defineAction` with `canDecideRefundRequest`.
 */

export type RefundRequestFormState = ActionResult<{ submitted: true }> | null

const PER_IP = { limit: 5, window: "1 h" } as const
const PER_TOKEN = { limit: 3, window: "1 d" } as const
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export async function submitRefundRequestAction(
  token: string,
  _previous: RefundRequestFormState,
  formData: FormData,
): Promise<RefundRequestFormState> {
  if (!tokenSchema.safeParse(token).success) {
    return { ok: false, error: "This purchase link isn't valid." }
  }
  const parsed = refundRequestFormSchema.safeParse({
    reason: formData.get("reason") ?? undefined,
    message: formData.get("message") ?? undefined,
  })
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error)
    return { ok: false, error: "Please check the highlighted fields and try again.", fieldErrors }
  }
  try {
    const ip = clientIp(await headers())
    const [byIp, byToken] = await Promise.all([
      rateLimit("refund-request", `ip:${ip}`, PER_IP),
      rateLimit("refund-request-token", token, PER_TOKEN),
    ])
    if (!byIp.success || !byToken.success) {
      return { ok: false, error: "Too many requests. Wait a while, then try again." }
    }
    const db = getDb()
    const result = await submitRefundRequest(db, { token, ...parsed.data })
    if (result.status === "not_found") {
      return { ok: false, error: "This purchase link isn't valid." }
    }
    if (result.status === "refused") {
      return { ok: false, error: REFUND_REFUSAL_MESSAGES[result.refusal] }
    }
    await runInBackground("refund_requests", "notify", () =>
      notifyRefundRequested(db, result.requestId),
    )
    revalidatePath(`/access/${token}/refund`)
    return { ok: true, data: { submitted: true } }
  } catch (error) {
    reportError(error, { tags: { action: "refund_requests.submit" } })
    return { ok: false, error: "Something went wrong on our side. Please try again." }
  }
}

async function authorizeDecision(
  user: Parameters<typeof canDecideRefundRequest>[0],
  requestId: string,
): Promise<boolean> {
  const [row] = await getDb()
    .select({ status: refundRequests.status })
    .from(refundRequests)
    .where(eq(refundRequests.id, requestId))
  if (!row) throw new ActionError(REFUND_DECISION_ERRORS.notFound)
  if (row.status !== "pending" && canDecideRefundRequest(user, { status: "pending" })) {
    throw new ActionError(REFUND_DECISION_ERRORS.decided)
  }
  return canDecideRefundRequest(user, row)
}

function revalidateAdmin(): void {
  revalidatePath("/admin/payouts")
  revalidatePath("/admin", "layout")
}

export const approveRefundRequestAction = defineAction({
  name: "refund_requests.approve",
  input: approveRefundRequestSchema,
  authorize: (user, input) => authorizeDecision(user, input.requestId),
  run: async ({ input, user, db }) => {
    const result = await approveRefundRequest(
      db,
      { requestId: input.requestId, admin: user, note: input.note },
      { gateway: getStripeGateway() },
    )
    revalidateAdmin()
    return result
  },
})

export const declineRefundRequestAction = defineAction({
  name: "refund_requests.decline",
  input: declineRefundRequestSchema,
  authorize: (user, input) => authorizeDecision(user, input.requestId),
  run: async ({ input, user, db }) => {
    await declineRefundRequest(db, { requestId: input.requestId, admin: user, note: input.note })
    revalidateAdmin()
    return { declined: true }
  },
})
