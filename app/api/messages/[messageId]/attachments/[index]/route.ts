import { getCurrentUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { attachmentResponse } from "@/lib/messages/download"

/**
 * A message attachment (§14: private files through short-lived signed URLs): redirects the thread's
 * participants (and admins) to a 5-minute download URL; 404 for everyone else. See
 * lib/messages/download.ts.
 */

type Context = { params: Promise<{ messageId: string; index: string }> }

export const dynamic = "force-dynamic"

export async function GET(_request: Request, context: Context): Promise<Response> {
  const params = await context.params
  return attachmentResponse(params, { db: getDb(), user: await getCurrentUser() })
}
