"use server"

import { revalidatePath } from "next/cache"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import { canRaiseDispute } from "@/lib/auth/authz"
import { getDb } from "@/lib/db/client"
import { runInBackground } from "@/lib/jobs/background"
import { rateLimit, type RateLimitRule } from "@/lib/ratelimit"

import { raiseDisputeSchema } from "./fields"
import {
  DISPUTE_MESSAGES,
  loadDisputeRaiseAccess,
  notifyDisputeOpened,
  raiseDispute,
} from "./service"

/** §19.38: at most 5 disputes raised per user per day. */
const DISPUTE_RAISE_RATE_LIMIT: RateLimitRule = { limit: 5, window: "1 d" }

/**
 * "Raise a dispute" on a collab (CLAUDE.md §19.38): an active member without an unresolved dispute
 * on it (`canRaiseDispute`). The refusals read plainly; the other member and the admins are
 * notified after the commit.
 */
export const raiseDisputeAction = defineAction({
  name: "disputes.raise",
  input: raiseDisputeSchema,
  authorize: async (user, input) => {
    const access = await loadDisputeRaiseAccess(getDb(), input.collabId, user.id)
    if (!access) throw new ActionError(DISPUTE_MESSAGES.notFound)
    if (access.hasUnresolvedDisputeByUser && access.memberUserIds.includes(user.id)) {
      throw new ActionError(DISPUTE_MESSAGES.alreadyOpen)
    }
    return canRaiseDispute(user, access)
  },
  run: async ({ input, user, db }) => {
    const limit = await rateLimit("dispute-raise", user.id, DISPUTE_RAISE_RATE_LIMIT)
    if (!limit.success) {
      throw new ActionError(
        "You've raised several disputes today. Try again tomorrow, or reply in the collab's messages.",
      )
    }
    const { disputeId } = await raiseDispute(db, {
      collabId: input.collabId,
      userId: user.id,
      kind: input.kind,
      description: input.description,
    })
    await runInBackground("disputes", "notify_opened", () => notifyDisputeOpened(db, disputeId))
    revalidatePath(`/app/collabs/${input.collabId}`)
    return { disputeId }
  },
})
