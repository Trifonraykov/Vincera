import { getDb } from "@/lib/db/client"
import { recordProductPageView } from "@/lib/launches/page-view"

/**
 * `product_page.viewed` beacon (CLAUDE.md §19.31; lib/launches/page-view.ts). A route handler,
 * not a server action: buyers have no account, and `defineAction` needs a signed-in user.
 */

type Context = { params: Promise<{ slug: string }> }

export const dynamic = "force-dynamic"

export async function POST(request: Request, context: Context): Promise<Response> {
  const { slug } = await context.params
  return recordProductPageView(request, slug, { db: getDb() })
}
