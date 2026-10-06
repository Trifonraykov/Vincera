import { getCurrentUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { env } from "@/lib/env"
import { dataExportResponse } from "@/lib/gdpr/export-route"

/**
 * "Export my data" (§14): the signed-in user's data as a JSON download. See
 * lib/gdpr/export-route.ts.
 */

export const dynamic = "force-dynamic"

export async function GET(): Promise<Response> {
  return dataExportResponse({ db: getDb(), user: await getCurrentUser(), appName: env.APP_NAME })
}
