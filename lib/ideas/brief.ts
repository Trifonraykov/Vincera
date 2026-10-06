import "server-only"

import { z } from "zod"

import type { ClaudeDeps } from "@/lib/ai/claude"
import {
  generateIdeaBrief,
  IDEA_BRIEF_LIMITS,
  ideaBriefOutputSchema,
  type IdeaBriefDraft,
} from "@/lib/ai/prompts/idea-brief"
import { now } from "@/lib/clock"
import { decrypt, DecryptionError, encrypt } from "@/lib/crypto"
import type { DbOrTx } from "@/lib/db/client"
import { track } from "@/lib/events/track"

import type { BriefUse } from "./save"
import { findCreatorContext } from "./queries"

/**
 * The idea brief drafter (§7.3 use 2) around its prompt (lib/ai/prompts/idea-brief.ts): build the
 * input from the creator's profile and the pasted comments, call Claude (never blocks: a failure
 * returns `draft: null` and the form stays as it was), record `ai.generated`, and hand the form a
 * sealed copy of the draft.
 *
 * Events (CLAUDE.md §19.25): `ai.generated` when the draft is generated (subject: the creator's
 * user, since no idea exists yet; `accepted_by_user` null, as for every generation, §19.6). When
 * the creator then saves an idea from it, `ai.reviewed { accepted, edited }` records the decision
 * (lib/ideas/brief-review.ts: "saved largely unchanged"), in the idea's create transaction.
 *
 * The sealed draft (`token`) is the generated fields encrypted with AES-GCM (lib/crypto.ts) and
 * bound to the user (AAD), so the review compares the saved idea with what the model really
 * wrote, not with whatever the browser sends back. It expires after a day. Comments are never
 * stored, logged or put in events.
 */

/** A sealed draft is accepted for this long after it was generated. */
export const BRIEF_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
/** Upper bound for the sealed draft in a form field. */
export const BRIEF_TOKEN_MAX = 20_000

const sealedSchema = z.object({
  v: z.literal(1),
  promptVersion: z.string().min(1).max(64),
  generatedAt: z.iso.datetime(),
  draft: ideaBriefOutputSchema,
})

function aadFor(userId: string): string {
  return `idea_brief:${userId}`
}

export function sealBrief(
  userId: string,
  brief: { promptVersion: string; draft: IdeaBriefDraft; generatedAt: Date },
): string {
  const payload: z.input<typeof sealedSchema> = {
    v: 1,
    promptVersion: brief.promptVersion,
    generatedAt: brief.generatedAt.toISOString(),
    draft: brief.draft,
  }
  return encrypt(JSON.stringify(payload), { aad: aadFor(userId) })
}

/**
 * The draft a form sent back, or null when it is missing, tampered with, another user's, or
 * older than a day (the idea is then saved without a review event; nothing fails).
 */
export function openBrief(userId: string, token: string | null | undefined): BriefUse | null {
  if (!token || token.length > BRIEF_TOKEN_MAX) return null
  let json: unknown
  try {
    json = JSON.parse(decrypt(token, { aad: aadFor(userId) }))
  } catch (error) {
    if (error instanceof DecryptionError || error instanceof SyntaxError) return null
    throw error
  }
  const parsed = sealedSchema.safeParse(json)
  if (!parsed.success) return null
  const age = now().getTime() - new Date(parsed.data.generatedAt).getTime()
  if (age < 0 || age > BRIEF_TOKEN_TTL_MS) return null
  return { promptVersion: parsed.data.promptVersion, draft: parsed.data.draft }
}

export type BriefDraftResult =
  | { ok: true; draft: IdeaBriefDraft; token: string; promptVersion: string }
  | { ok: false; reason: "no_profile" | "fallback" }

/**
 * Draft idea fields from pasted comments. Never throws for model failures (`fallback`); the
 * caller shows a plain message and the creator fills the form in by hand.
 */
export async function draftIdeaBrief(
  database: DbOrTx,
  input: { userId: string; comments: string },
  deps: ClaudeDeps = {},
): Promise<BriefDraftResult> {
  const profile = await findCreatorContext(database, input.userId)
  if (!profile) return { ok: false, reason: "no_profile" }

  const result = await generateIdeaBrief(
    {
      comments: input.comments.slice(0, IDEA_BRIEF_LIMITS.comments),
      niche: profile.niche,
      profileTopics: profile.topics,
      audienceSummary: profile.audienceSummary,
    },
    deps,
  )
  await track(
    "ai.generated",
    {
      actorUserId: input.userId,
      subjectType: "user",
      subjectId: input.userId,
      properties: {
        use: "idea_brief",
        prompt_version: result.promptVersion,
        model: result.model,
        latency_ms: result.latencyMs,
        accepted_by_user: null,
        fallback: !result.ok,
      },
    },
    database,
  )
  if (!result.ok) return { ok: false, reason: "fallback" }
  return {
    ok: true,
    draft: result.data,
    promptVersion: result.promptVersion,
    token: sealBrief(input.userId, {
      promptVersion: result.promptVersion,
      draft: result.data,
      generatedAt: now(),
    }),
  }
}
