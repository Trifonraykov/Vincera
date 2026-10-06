"use server"

import { createElement } from "react"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import { signOut } from "@/lib/auth/auth"
import { canDeleteOwnAccount } from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { sendEmail } from "@/lib/email/send"
import AccountDeletedEmail, { accountDeletedSubject } from "@/lib/email/templates/account-deleted"
import { env } from "@/lib/env"
import { runInBackground } from "@/lib/jobs/background"
import { enqueue } from "@/lib/jobs/enqueue"
import { reportError } from "@/lib/observability"
import { rateLimit, type RateLimitRule } from "@/lib/ratelimit"
import { revokeTokens } from "@/lib/social/revoke"

import { deleteAccount } from "./delete"
import { deleteAccountSchema } from "./fields"

/** §19.38: 5 deletion attempts per user per hour. */
const GDPR_DELETE_RATE_LIMIT: RateLimitRule = { limit: 5, window: "1 h" }

/**
 * "Delete account" (§14; CLAUDE.md §19.38, §19.40): typed confirmation, then the anonymising
 * transaction (lib/gdpr/delete.ts). After the commit: the confirmation email to the old address,
 * the storage cleanup job, a best-effort token revocation, and this browser is signed out (every
 * other session was deleted in the transaction).
 */
export const deleteAccountAction = defineAction({
  name: "gdpr.delete_account",
  input: deleteAccountSchema,
  authorize: (user) => canDeleteOwnAccount(user),
  run: async ({ user, db }) => {
    const limit = await rateLimit("gdpr-delete", user.id, GDPR_DELETE_RATE_LIMIT)
    if (!limit.success) throw new ActionError("Too many attempts. Try again in an hour.")

    const result = await deleteAccount(db, { userId: user.id, now: now() })

    if (result.email) {
      try {
        await sendEmail({
          to: result.email,
          subject: accountDeletedSubject(env.APP_NAME),
          react: createElement(AccountDeletedEmail, { appName: env.APP_NAME }),
          tags: { type: "account_deleted" },
          idempotencyKey: `account-deleted:${user.id}`,
        })
      } catch (error) {
        reportError(error, { tags: { area: "gdpr", step: "confirmation_email" } })
      }
    }
    try {
      await enqueue(
        "gdpr/cleanup.requested",
        { userId: user.id, storageKeys: result.storageKeys },
        { id: `gdpr-cleanup:${user.id}` },
      )
    } catch (error) {
      reportError(error, { tags: { area: "gdpr", step: "enqueue_cleanup" } })
    }
    if (result.revocations.length > 0) {
      await runInBackground("gdpr", "revoke_tokens", async () => {
        await Promise.all(
          result.revocations.map(({ provider, tokens }) => revokeTokens(provider, tokens)),
        )
      })
    }

    await signOut({ redirectTo: "/?account=deleted" })
    return { deleted: true }
  },
})
