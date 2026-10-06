import type { NextRequest } from "next/server"

import { impersonationRefusalResponse } from "@/lib/auth/impersonation"
import { getCurrentUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { oauthCallbackResponse } from "@/lib/social/oauth-flow"

/**
 * OAuth callback for social data connections (§3 `/api/oauth/[provider]/callback`, §7.1): checks
 * the state cookie, exchanges the code, stores the connection with encrypted tokens and queues
 * the first sync, then returns to the page that started it. See lib/social/oauth-flow.ts.
 */

type Context = { params: Promise<{ provider: string }> }

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  const { provider } = await context.params
  const user = await getCurrentUser()
  // Read-only "view as" (CLAUDE.md §19.38): connecting an account is a change.
  const refused = await impersonationRefusalResponse(user)
  if (refused) return refused
  return oauthCallbackResponse(request, provider, { user, db: getDb() })
}
