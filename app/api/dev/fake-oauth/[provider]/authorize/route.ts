import { fakeAuthorizeGet, fakeAuthorizePost } from "@/lib/social/fake/authorize-page"

/**
 * Fake social consent screen (§19.3): where a fake provider's `authUrl()` points. Lists the
 * fixture accounts in `tests/fixtures/social/<provider>/`; "Authorize as …" redirects to our
 * real `/api/oauth/<provider>/callback` with a signed code and the state. 404 unless that
 * provider is fake (never in production). See lib/social/fake/authorize-page.ts.
 */

type Context = { params: Promise<{ provider: string }> }

export const dynamic = "force-dynamic"

export async function GET(request: Request, context: Context): Promise<Response> {
  return fakeAuthorizeGet(request, (await context.params).provider)
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return fakeAuthorizePost(request, (await context.params).provider)
}
