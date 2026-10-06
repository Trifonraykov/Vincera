import { agreementPdfResponse } from "@/lib/agreements/download"
import { getCurrentUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"

/**
 * The signed agreement PDF (§12, §14: private files through short-lived signed URLs): redirects
 * the collab's members (and admins) to a 5-minute download URL; 404 for everyone else. See
 * lib/agreements/download.ts.
 */

type Context = { params: Promise<{ agreementId: string }> }

export const dynamic = "force-dynamic"

export async function GET(_request: Request, context: Context): Promise<Response> {
  const params = await context.params
  return agreementPdfResponse(params, { db: getDb(), user: await getCurrentUser() })
}
