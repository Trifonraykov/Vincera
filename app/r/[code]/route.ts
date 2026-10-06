import { handleTrackedLinkRequest } from "@/lib/attribution/click"
import { getDb } from "@/lib/db/client"

/**
 * Tracked-link redirect (§10, §12 `/r/[code]`): logs the click, sets the attribution cookie (last
 * click wins, 30 days) and answers 302 to `/p/<slug>`. See lib/attribution/click.ts.
 */

type Context = { params: Promise<{ code: string }> }

export const dynamic = "force-dynamic"

export async function GET(request: Request, context: Context): Promise<Response> {
  const { code } = await context.params
  return handleTrackedLinkRequest(request, code, { db: getDb() })
}
