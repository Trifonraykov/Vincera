import { getDb } from "@/lib/db/client"
import { ACCESS_RATE_LIMIT, accessFileUrl } from "@/lib/delivery/access"
import { reportError } from "@/lib/observability"
import { clientIp, rateLimit } from "@/lib/ratelimit"

/**
 * A buyer's file download (§12 `/access/[token]`, §14 signed URLs): 302 to a 5-minute signed
 * storage URL for one file of the purchase, made per click. Unknown or revoked tokens, files of
 * other launches and non-file deliveries answer 404. A redirect route handler (§4). See
 * lib/delivery/access.ts.
 */

type Context = { params: Promise<{ token: string; fileId: string }> }

export const dynamic = "force-dynamic"

const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
} as const

export async function GET(request: Request, context: Context): Promise<Response> {
  const { token, fileId } = await context.params
  const limit = await rateLimit("access", clientIp(request.headers), ACCESS_RATE_LIMIT)
  if (!limit.success) {
    return new Response("Too many requests. Wait a minute, then try again.", {
      status: 429,
      headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    })
  }
  let url: string | null = null
  try {
    url = await accessFileUrl(getDb(), token, fileId)
  } catch (error) {
    reportError(error, { tags: { area: "access" } })
    return new Response("We couldn't prepare this download. Try again in a moment.", {
      status: 502,
      headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    })
  }
  if (!url) {
    return new Response("Not Found", {
      status: 404,
      headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    })
  }
  return new Response(null, { status: 302, headers: { ...HEADERS, Location: url } })
}
