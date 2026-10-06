import { getDb } from "@/lib/db/client"
import { portfolioImageResponse } from "@/lib/profiles/portfolio-image"

/**
 * A portfolio project's image (§5 portfolio_items.image_url; §14 signed URLs for private files):
 * redirects to a short-lived signed URL of the stored image, or 404. Portfolio images are public
 * profile content, so no session is needed. See lib/profiles/portfolio-image.ts.
 */

type Context = { params: Promise<{ itemId: string }> }

export const dynamic = "force-dynamic"

export async function GET(_request: Request, context: Context): Promise<Response> {
  const { itemId } = await context.params
  return portfolioImageResponse(itemId, { db: getDb() })
}
