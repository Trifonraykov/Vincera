import "server-only"

import { unstable_rethrow } from "next/navigation"
import { z } from "zod"

import {
  IMPERSONATION_READ_ONLY_MESSAGE,
  isMutationBlockedByImpersonation,
} from "@/lib/auth/impersonation"
import { requireUser } from "@/lib/auth/session"
import type { AuthUser } from "@/lib/auth/user"
import { getDb, type Db } from "@/lib/db/client"
import { reportError } from "@/lib/observability"

import { ActionError } from "./errors"
import { ACTION_MESSAGES, type ActionResult } from "./result"

export { ActionError } from "./errors"
export { ACTION_MESSAGES, type ActionResult, type FieldErrors } from "./result"

/**
 * Server action recipe (§4), in one place:
 *
 * 1. parse the input with Zod (field errors come back to the form);
 * 2. `requireUser()` (signed-out → /sign-in, suspended → error page); during an admin's read-only
 *    "view as" every action is refused here, before `authorize` (CLAUDE.md §19.38);
 * 3. `authorize(user, input)` with a rule from lib/auth/authz.ts;
 * 4./5. `run()` does the work. Transactions and events stay explicit in `run`, because only the
 *    action knows which writes belong together:
 *
 * ```ts
 * "use server"
 * export const archiveIdea = defineAction({
 *   name: "ideas.archive",
 *   input: z.object({ ideaId: z.uuid() }),
 *   authorize: async (user, { ideaId }) => canEditIdea(user, await loadIdeaAccess(ideaId)),
 *   run: ({ input, user, db }) =>
 *     withTransaction(async (tx) => {
 *       await tx.update(ideas).set({ status: "archived" }).where(eq(ideas.id, input.ideaId))
 *       await track("idea.archived", { actorUserId: user.id, subjectType: "idea",
 *         subjectId: input.ideaId, properties: {} }, tx)
 *     }, db),
 * })
 * ```
 *
 * The returned function resolves to an `ActionResult` and never throws for expected failures.
 * Throw `ActionError` from `run` for a failure the user should read; anything else is reported
 * to Sentry and the user sees a generic message. Next.js control flow (`redirect()`,
 * `notFound()`) passes through.
 */

export type ActionContext<Input> = { input: Input; user: AuthUser; db: Db }

export type ActionDefinition<Schema extends z.ZodType, T> = {
  /** Identifies the action in Sentry, e.g. "onboarding.choose_role". */
  name: string
  input: Schema
  /**
   * Permission check, a rule from lib/auth/authz.ts (§4, §6). Required, so no action can skip it;
   * self-service actions on the user's own account use `canManageOwnAccount`.
   */
  authorize: (user: AuthUser, input: z.output<Schema>) => boolean | Promise<boolean>
  run: (context: ActionContext<z.output<Schema>>) => Promise<T>
}

/** FormData → plain object for Zod; repeated keys become arrays, files are kept as they are. */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of new Set(formData.keys())) {
    const values = formData.getAll(key)
    result[key] = values.length === 1 ? values[0] : values
  }
  return result
}

export function defineAction<Schema extends z.ZodType, T>(
  definition: ActionDefinition<Schema, T>,
): (input: z.input<Schema> | FormData) => Promise<ActionResult<T>> {
  // The type requires it; this also stops casts and plain JavaScript from leaving it out.
  if (typeof definition.authorize !== "function") {
    throw new TypeError(`defineAction("${definition.name}"): authorize is required (§4)`)
  }
  return async (rawInput) => {
    const parsed = definition.input.safeParse(
      rawInput instanceof FormData ? formDataToObject(rawInput) : rawInput,
    )
    if (!parsed.success) {
      const { formErrors, fieldErrors } = z.flattenError(parsed.error)
      return {
        ok: false,
        error: formErrors[0] ?? ACTION_MESSAGES.invalidInput,
        fieldErrors,
      }
    }

    try {
      const user = await requireUser()
      if (await isMutationBlockedByImpersonation(user)) {
        return { ok: false, error: IMPERSONATION_READ_ONLY_MESSAGE }
      }
      const input = parsed.data
      if (!(await definition.authorize(user, input))) {
        return { ok: false, error: ACTION_MESSAGES.forbidden }
      }
      return { ok: true, data: await definition.run({ input, user, db: getDb() }) }
    } catch (error) {
      unstable_rethrow(error)
      if (error instanceof ActionError) {
        return error.fieldErrors
          ? { ok: false, error: error.message, fieldErrors: error.fieldErrors }
          : { ok: false, error: error.message }
      }
      reportError(error, { tags: { action: definition.name } })
      return { ok: false, error: ACTION_MESSAGES.unexpected }
    }
  }
}
