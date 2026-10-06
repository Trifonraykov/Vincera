"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import type { LaunchKitOutput } from "@/lib/ai/prompts/launch-kit"
import {
  canEndLaunch,
  canReviewLaunch,
  canViewLaunchSetup,
  canWorkInCollab,
  isCollabMember,
  type AuthzUser,
} from "@/lib/auth/authz"
import { loadCollabAccess } from "@/lib/collabs/queries"
import { getDb } from "@/lib/db/client"
import { rateLimit } from "@/lib/ratelimit"

import {
  addLaunchFile,
  addLaunchMedia,
  addLicenseKeys,
  createLaunchUpload,
  discardLaunchUpload,
  removeLaunchFile,
  removeLaunchMedia,
  removeUnassignedKeys,
} from "./content"
import { launchFormSchema, reviewNoteSchema } from "./fields"
import { generateKitFor, loadKitContext } from "./kit"
import { loadLaunchAccess } from "./queries"
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
} from "./service"

/**
 * Launch server actions (§4, §12 "Launch setup page"; CLAUDE.md §19.32). `authorize` checks that
 * the user may see the launch (`canViewLaunchSetup`: members and admins) and is a member, or an
 * admin for the review actions; the services then apply the exact rule (`canEditLaunch`,
 * `canApproveLaunch`, …) again under the launch's row lock with plain-language refusals.
 */

const launchId = z.uuid({ error: "That launch link is not valid." })

/** Members only (admins read the setup page but never act as a party). */
async function authorizeMember(user: AuthzUser, id: string): Promise<boolean> {
  const access = await loadLaunchAccess(getDb(), id)
  if (!access || !isCollabMember(user, access)) throw new ActionError(LAUNCH_ERRORS.notFound)
  return canViewLaunchSetup(user, access)
}

/** Members, or admins (pause and resume). */
async function authorizeMemberOrAdmin(user: AuthzUser, id: string): Promise<boolean> {
  const access = await loadLaunchAccess(getDb(), id)
  if (!access || !canViewLaunchSetup(user, access)) throw new ActionError(LAUNCH_ERRORS.notFound)
  return true
}

/** The setup page, the collab pages, the launches list and the admin queue all show launches. */
function revalidateLaunchViews(): void {
  revalidatePath("/app", "layout")
  revalidatePath("/admin/launches")
}

export const createLaunchAction = defineAction({
  name: "launches.create",
  input: z.object({ collabId: z.uuid({ error: "That collab link is not valid." }) }),
  authorize: async (user, input) => {
    const collab = await loadCollabAccess(getDb(), input.collabId)
    if (!collab || !isCollabMember(user, collab)) {
      throw new ActionError(LAUNCH_ERRORS.collabNotFound)
    }
    if (!canWorkInCollab(user, collab)) throw new ActionError(LAUNCH_ERRORS.collabEnded)
    return true
  },
  run: async ({ input, user, db }) => {
    const result = await createLaunch(db, user, input)
    revalidateLaunchViews()
    return result
  },
})

export const saveLaunchAction = defineAction({
  name: "launches.save",
  input: launchFormSchema.extend({ launchId }),
  authorize: (user, input) => authorizeMember(user, input.launchId),
  run: async ({ input, user, db }) => {
    const { launchId: id, ...fields } = input
    const result = await saveLaunch(db, user, { launchId: id, fields })
    revalidateLaunchViews()
    return result
  },
})

export const approveLaunchAction = defineAction({
  name: "launches.approve",
  input: z.object({ launchId }),
  authorize: (user, input) => authorizeMember(user, input.launchId),
  run: async ({ input, user, db }) => {
    const result = await approveLaunch(db, user, input)
    revalidateLaunchViews()
    return result
  },
})

export const pauseLaunchAction = defineAction({
  name: "launches.pause",
  input: z.object({ launchId }),
  authorize: (user, input) => authorizeMemberOrAdmin(user, input.launchId),
  run: async ({ input, user, db }) => {
    const result = await pauseLaunch(db, user, input)
    revalidateLaunchViews()
    return result
  },
})

export const resumeLaunchAction = defineAction({
  name: "launches.resume",
  input: z.object({ launchId }),
  authorize: (user, input) => authorizeMemberOrAdmin(user, input.launchId),
  run: async ({ input, user, db }) => {
    const result = await resumeLaunch(db, user, input)
    revalidateLaunchViews()
    return result
  },
})

// --- Files, images and keys -----------------------------------------------------------------

/** 20 signed upload URLs per member per hour (CLAUDE.md §19.31 `launch-file-upload`). */
const UPLOAD_RATE_LIMIT = { limit: 20, window: "1 h" } as const

export const requestLaunchUploadAction = defineAction({
  name: "launches.request_upload",
  input: z.object({
    launchId,
    kind: z.enum(["deliverable", "media"]),
    contentType: z.string().max(200),
    sizeBytes: z.number().int().min(0),
  }),
  authorize: (user, input) => authorizeMember(user, input.launchId),
  run: async ({ input, user }) => {
    const limit = await rateLimit("launch-file-upload", user.id, UPLOAD_RATE_LIMIT)
    if (!limit.success) {
      throw new ActionError("You've uploaded a lot of files in a short time. Try again in an hour.")
    }
    return createLaunchUpload({ userId: user.id, ...input })
  },
})

/** Fields are read loosely, so the upload is deleted even when they do not parse. */
const uploadInput = z.looseObject({ launchId, uploadKey: z.unknown() })

export const addLaunchFileAction = defineAction({
  name: "launches.add_file",
  input: uploadInput,
  authorize: (user, input) => authorizeMember(user, input.launchId),
  run: async ({ input, user, db }) => {
    try {
      const fields = z
        .object({ uploadKey: z.string().min(1).max(512), filename: z.string().min(1).max(512) })
        .safeParse(input)
      if (!fields.success) throw new ActionError("Upload the file again, then add it.")
      const result = await addLaunchFile(db, user, { launchId: input.launchId, ...fields.data })
      revalidateLaunchViews()
      return result
    } finally {
      await discardLaunchUpload(user.id, input.uploadKey)
    }
  },
})

export const removeLaunchFileAction = defineAction({
  name: "launches.remove_file",
  input: z.object({ launchId, fileId: z.uuid() }),
  authorize: (user, input) => authorizeMember(user, input.launchId),
  run: async ({ input, user, db }) => {
    await removeLaunchFile(db, user, input)
    revalidateLaunchViews()
    return { removed: true as const }
  },
})

export const addLaunchMediaAction = defineAction({
  name: "launches.add_media",
  input: uploadInput,
  authorize: (user, input) => authorizeMember(user, input.launchId),
  run: async ({ input, user, db }) => {
    try {
      const fields = z
        .object({
          uploadKey: z.string().min(1).max(512),
          alt: z.string().max(1000).optional(),
        })
        .safeParse(input)
      if (!fields.success) throw new ActionError("Upload the image again, then add it.")
      const result = await addLaunchMedia(db, user, {
        launchId: input.launchId,
        uploadKey: fields.data.uploadKey,
        alt: fields.data.alt ?? null,
      })
      revalidateLaunchViews()
      return result
    } finally {
      await discardLaunchUpload(user.id, input.uploadKey)
    }
  },
})

export const removeLaunchMediaAction = defineAction({
  name: "launches.remove_media",
  input: z.object({ launchId, name: z.string().regex(/^[0-9a-f-]{36}\.[a-z0-9]+$/) }),
  authorize: (user, input) => authorizeMember(user, input.launchId),
  run: async ({ input, user, db }) => {
    await removeLaunchMedia(db, user, input)
    revalidateLaunchViews()
    return { removed: true as const }
  },
})

export const addLicenseKeysAction = defineAction({
  name: "launches.add_keys",
  input: z.object({ launchId, keys: z.string().max(250_000, "Paste fewer keys at a time.") }),
  authorize: (user, input) => authorizeMember(user, input.launchId),
  run: async ({ input, user, db }) => {
    const result = await addLicenseKeys(db, user, { launchId: input.launchId, text: input.keys })
    revalidateLaunchViews()
    return result
  },
})

export const removeUnassignedKeysAction = defineAction({
  name: "launches.remove_keys",
  input: z.object({ launchId }),
  authorize: (user, input) => authorizeMember(user, input.launchId),
  run: async ({ input, user, db }) => {
    const result = await removeUnassignedKeys(db, user, input)
    revalidateLaunchViews()
    return result
  },
})

// --- Admin review ---------------------------------------------------------------------------

async function authorizeReview(user: AuthzUser, id: string): Promise<boolean> {
  const access = await loadLaunchAccess(getDb(), id)
  if (!access) throw new ActionError(LAUNCH_ERRORS.notFound)
  if (!canReviewLaunch(user, access)) throw new ActionError(LAUNCH_ERRORS.notInReview)
  return true
}

export const adminApproveLaunchAction = defineAction({
  name: "launches.admin_approve",
  input: z.object({ launchId }),
  authorize: (user, input) => authorizeReview(user, input.launchId),
  run: async ({ input, user, db }) => {
    const result = await adminApproveLaunch(db, user, input)
    revalidateLaunchViews()
    return result
  },
})

export const adminRejectLaunchAction = defineAction({
  name: "launches.admin_reject",
  input: z.object({ launchId, note: reviewNoteSchema }),
  authorize: (user, input) => authorizeReview(user, input.launchId),
  run: async ({ input, user, db }) => {
    const result = await adminRejectLaunch(db, user, input)
    revalidateLaunchViews()
    return result
  },
})

export const adminEndLaunchAction = defineAction({
  name: "launches.admin_end",
  input: z.object({ launchId }),
  authorize: async (user, input) => {
    const access = await loadLaunchAccess(getDb(), input.launchId)
    if (!access) throw new ActionError(LAUNCH_ERRORS.notFound)
    return canEndLaunch(user, access)
  },
  run: async ({ input, user, db }) => {
    const result = await endLaunch(db, user, input)
    revalidateLaunchViews()
    return result
  },
})

// --- Launch kit -----------------------------------------------------------------------------

/** 10 generations per member per hour (CLAUDE.md §19.31 `launch-kit`). */
const KIT_RATE_LIMIT = { limit: 10, window: "1 h" } as const

export const generateLaunchKitAction = defineAction({
  name: "launches.generate_kit",
  input: z.object({ launchId }),
  authorize: (user, input) => authorizeMember(user, input.launchId),
  run: async ({ input, user, db }): Promise<{ kit: LaunchKitOutput }> => {
    const context = await loadKitContext(db, input.launchId)
    if (!context?.link) {
      throw new ActionError("The launch kit is ready once the launch has gone live.")
    }
    const limit = await rateLimit("launch-kit", user.id, KIT_RATE_LIMIT)
    if (!limit.success) {
      throw new ActionError(
        "You've drafted a few kits already. Use the posts you have, or try again later.",
      )
    }
    const result = await generateKitFor(db, { userId: user.id, context })
    if (!result.ok) {
      throw new ActionError(
        "We couldn't write posts right now. Your tracked link is ready to share; try again in a moment.",
      )
    }
    return { kit: result.kit }
  },
})
