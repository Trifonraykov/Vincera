"use server"

import { revalidatePath } from "next/cache"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import { canCreateTrackedLink, canManageOwnAccount } from "@/lib/auth/authz"
import { getDb } from "@/lib/db/client"
import { loadLaunchAccess } from "@/lib/launches/queries"
import { rateLimit } from "@/lib/ratelimit"
import { getStripeGateway } from "@/lib/stripe/gateway"

import { createLinkSchema, disableLinkSchema, renameLinkSchema } from "./fields"
import { createTrackedLink, disableTrackedLink, LINK_ERRORS, renameTrackedLink } from "./service"

/**
 * Tracked link actions (`/app/launches/[id]/links`; CLAUDE.md §19.38). Creating needs
 * `canCreateTrackedLink` (a member of a live or paused launch) and the `tracked-link-create`
 * limit (20 per user per hour); renaming and turning off check `canManageTrackedLink` under the
 * link's row lock in the service (the owner only), so `authorize` here only requires an active
 * account.
 */

const TRACKED_LINK_CREATE_LIMIT = { limit: 20, window: "1 h" } as const

function revalidateLinks(launchId: string): void {
  revalidatePath(`/app/launches/${launchId}/links`)
}

export const createTrackedLinkAction = defineAction({
  name: "tracked_links.create",
  input: createLinkSchema,
  authorize: async (user, input) => {
    const access = await loadLaunchAccess(getDb(), input.launchId)
    if (!access) throw new ActionError(LINK_ERRORS.notFound)
    if (!canCreateTrackedLink(user, access)) {
      if (access.memberUserIds.includes(user.id)) throw new ActionError(LINK_ERRORS.launchNotOpen)
      return false
    }
    return true
  },
  run: async ({ input, user, db }) => {
    const limit = await rateLimit("tracked-link-create", user.id, TRACKED_LINK_CREATE_LIMIT)
    if (!limit.success) {
      throw new ActionError("You've added a lot of links in the last hour. Try again later.")
    }
    const link = await createTrackedLink(
      db,
      { ...input, ownerUserId: user.id },
      { gateway: getStripeGateway() },
    )
    revalidateLinks(input.launchId)
    return link
  },
})

export const renameTrackedLinkAction = defineAction({
  name: "tracked_links.rename",
  input: renameLinkSchema,
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ input, user, db }) => {
    const result = await renameTrackedLink(db, user, input)
    revalidateLinks(result.launchId)
    return { changed: result.changed }
  },
})

export const disableTrackedLinkAction = defineAction({
  name: "tracked_links.disable",
  input: disableLinkSchema,
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ input, user, db }) => {
    const result = await disableTrackedLink(db, user, input, { gateway: getStripeGateway() })
    revalidateLinks(result.launchId)
    return { changed: result.changed }
  },
})
