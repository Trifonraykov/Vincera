import type { NextRequest } from "next/server"

import { getCurrentUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { oauthStartResponse } from "@/lib/social/oauth-flow"

/**
 * Start a social data connection (§7.1): `GET /api/oauth/<provider>/start?returnTo=<path>`.
 * Sets the encrypted state/PKCE cookie and redirects to the provider's consent screen (the dev
 * consent page when the provider is fake). See lib/social/oauth-flow.ts.
 */

type Context = { params: Promise<{ provider: string }> }

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  const { provider } = await context.params
  return oauthStartResponse(request, provider, { user: await getCurrentUser(), db: getDb() })
}
