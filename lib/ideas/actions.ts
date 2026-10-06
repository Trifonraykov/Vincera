"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import type { IdeaBriefDraft } from "@/lib/ai/prompts/idea-brief"
import type { AuthUser } from "@/lib/auth/user"
import { canCreateIdea, canManageIdea } from "@/lib/auth/authz"
import { getDb } from "@/lib/db/client"
import { requestEmbeddingRefreshAfterCommit } from "@/lib/embeddings/request"
import { rateLimit, type RateLimitRule } from "@/lib/ratelimit"

import { BRIEF_TOKEN_MAX, draftIdeaBrief, openBrief } from "./brief"
import { IDEA_COMMENTS_MAX, IDEA_COMMENTS_MIN, ideaFormSchema } from "./fields"
import { findIdeaAccess } from "./queries"
import { createIdea, transitionIdea, updateIdea } from "./save"

/**
 * Server actions for ideas (§4, §12 `/app/ideas/*`; CLAUDE.md §19.25): create, save (and
 * publish), archive / restore, and the AI brief drafter. Each authorizes with lib/auth/authz.ts
 * (`canCreateIdea`, `canManageIdea` on the stored owner). After the commit the embedding refresh
 * is requested (which then asks matching to recompute) and the pages are revalidated.
 */

/** Brief drafts: 10 per creator per hour (each is a model call, §19.24). */
const IDEA_BRIEF_RATE_LIMIT: RateLimitRule = { limit: 10, window: "1 h" }

const ideaIdField = z.uuid({ error: "Unknown idea." })

async function ownsIdea(user: AuthUser, ideaId: string): Promise<boolean> {
  const access = await findIdeaAccess(getDb(), ideaId)
  return access !== null && canManageIdea(user, access)
}

async function afterIdeaChange(ideaId: string): Promise<void> {
  await requestEmbeddingRefreshAfterCommit({ type: "idea", id: ideaId })
  revalidatePath("/app/ideas")
  revalidatePath(`/app/ideas/${ideaId}`)
  revalidatePath("/app")
}

/** `/app/ideas/new`: save a draft or publish at once, then open the idea. */
export const createIdeaAction = defineAction({
  name: "ideas.create",
  input: ideaFormSchema.extend({ brief: z.string().max(BRIEF_TOKEN_MAX).optional() }),
  authorize: (user) => canCreateIdea(user),
  run: async ({ input, user, db }) => {
    const { intent, brief, ...fields } = input
    const result = await createIdea(db, {
      userId: user.id,
      fields,
      intent,
      brief: openBrief(user.id, brief),
    })
    await afterIdeaChange(result.ideaId)
    redirect(`/app/ideas/${result.ideaId}?saved=${result.published ? "published" : "created"}`)
  },
})

/** `/app/ideas/[id]`: save the form; "Publish" on a draft also publishes it. */
export const updateIdeaAction = defineAction({
  name: "ideas.update",
  input: ideaFormSchema.extend({ ideaId: ideaIdField }),
  authorize: (user, { ideaId }) => ownsIdea(user, ideaId),
  run: async ({ input, user, db }) => {
    const { ideaId, intent, ...fields } = input
    const result = await updateIdea(db, { userId: user.id, ideaId, fields, intent })
    if (result.fields.length > 0 || result.published) await afterIdeaChange(ideaId)
    return { status: result.status, published: result.published, changed: result.fields }
  },
})

/** Publish (from a draft), archive or restore. */
export const changeIdeaStatusAction = defineAction({
  name: "ideas.change_status",
  input: z.object({
    ideaId: ideaIdField,
    action: z.enum(["publish", "archive", "restore"], { error: "Unknown action." }),
  }),
  authorize: (user, { ideaId }) => ownsIdea(user, ideaId),
  run: async ({ input, user, db }) => {
    const result = await transitionIdea(db, {
      userId: user.id,
      ideaId: input.ideaId,
      action: input.action,
    })
    await afterIdeaChange(input.ideaId)
    return { status: result.status }
  },
})

export type IdeaBriefActionResult = {
  draft: IdeaBriefDraft
  /** The sealed draft the form sends back with the save (lib/ideas/brief.ts). */
  token: string
}

/**
 * The idea brief drafter (§7.3.2): pasted audience comments → idea fields for the form. A model
 * failure is a plain message; the form keeps working without it (§7.3 "never block").
 */
export const draftIdeaBriefAction = defineAction({
  name: "ideas.draft_brief",
  input: z.object({
    comments: z
      .string({ error: "Paste a few comments from your audience." })
      .transform((value) => value.replace(/\r\n?/g, "\n").trim())
      .pipe(
        z
          .string()
          .min(IDEA_COMMENTS_MIN, "Paste a few comments from your audience.")
          .max(
            IDEA_COMMENTS_MAX,
            `Paste at most ${IDEA_COMMENTS_MAX.toLocaleString("en-US")} characters of comments.`,
          ),
      ),
  }),
  authorize: (user) => canCreateIdea(user),
  run: async ({ input, user, db }): Promise<IdeaBriefActionResult> => {
    const limit = await rateLimit("idea-brief", user.id, IDEA_BRIEF_RATE_LIMIT)
    if (!limit.success) {
      throw new ActionError(
        "You've drafted a few ideas already. Fill in the fields yourself, or try again later.",
      )
    }
    const result = await draftIdeaBrief(db, { userId: user.id, comments: input.comments })
    if (!result.ok) {
      throw new ActionError(
        result.reason === "no_profile"
          ? "Create your creator profile first."
          : "We couldn't draft it right now. Fill in the fields yourself, or try again in a moment.",
      )
    }
    return { draft: result.draft, token: result.token }
  },
})
