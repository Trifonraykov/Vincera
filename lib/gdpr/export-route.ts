import "server-only"

import { canExportOwnData } from "@/lib/auth/authz"
import { impersonationRefusalResponse } from "@/lib/auth/impersonation"
import { signInUrl } from "@/lib/auth/routes"
import type { AuthUser } from "@/lib/auth/user"
import { now } from "@/lib/clock"
import { withTransaction, type Db } from "@/lib/db/client"
import { track } from "@/lib/events/track"
import { rateLimit, retryAfterSeconds, type RateLimitRule } from "@/lib/ratelimit"

import { buildDataExport, dataExportFilename } from "./export"

/** §19.38: 3 exports per user per hour (each reads every table the user appears in). */
export const GDPR_EXPORT_RATE_LIMIT: RateLimitRule = { limit: 3, window: "1 h" }

const ACCOUNT_PAGE = "/app/settings/account"

function plain(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  })
}

/**
 * `GET /app/settings/account/export` (§14 "Data export (JSON)"; CLAUDE.md §19.38): the signed-in
 * user's own data as a JSON download. Signed out → the sign-in page; refused during an admin's
 * read-only "view as" (a person's export is theirs to download, and it records an event); rate
 * limited. The document is built and `user.data_exported` is recorded in one read-consistent
 * transaction.
 */
export async function dataExportResponse(deps: {
  db: Db
  user: AuthUser | null
  appName: string
}): Promise<Response> {
  const { user } = deps
  if (!user) {
    return new Response(null, {
      status: 303,
      headers: { Location: signInUrl({ callbackUrl: ACCOUNT_PAGE }), "Cache-Control": "no-store" },
    })
  }
  const refusal = await impersonationRefusalResponse(user)
  if (refusal) return refusal
  if (!canExportOwnData(user)) return plain(403, "Your account can't export data right now.")

  const limit = await rateLimit("gdpr-export", user.id, GDPR_EXPORT_RATE_LIMIT)
  if (!limit.success) {
    return plain(
      429,
      "You've downloaded your data several times in the last hour. Try again later.",
      { "Retry-After": String(retryAfterSeconds(limit)) },
    )
  }

  const at = now()
  const document = await withTransaction(async (tx) => {
    const data = await buildDataExport(tx, { userId: user.id, now: at, appName: deps.appName })
    await track(
      "user.data_exported",
      {
        actorUserId: user.id,
        subjectType: "user",
        subjectId: user.id,
        properties: { format: "json" },
      },
      tx,
    )
    return data
  }, deps.db)

  return new Response(JSON.stringify(document, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${dataExportFilename(deps.appName, at)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
