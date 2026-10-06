import "server-only"

import { canManageOwnAccount } from "@/lib/auth/authz"
import { impersonationRefusalResponse } from "@/lib/auth/impersonation"
import { requireUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { reportError } from "@/lib/observability"
import { absoluteUrl } from "@/lib/urls"

import { createOnboardingLink, findStripeAccountByUser } from "./connect"
import { PAYOUTS_PAGES, type PayoutsPage } from "./paths"

/**
 * Stripe's `refresh_url` (§7.2): Stripe opens it when an onboarding link expired or was already
 * used. We create a fresh link for the signed-in user's existing account and redirect to it
 * (Stripe's recommended flow). It never creates an account: without one, or when Stripe fails,
 * the user lands back on the payouts page (with `?error=link` on failure).
 */
export async function handlePayoutsRefresh(from: PayoutsPage): Promise<Response> {
  const user = await requireUser()
  // Read-only "view as" (CLAUDE.md §19.38): a new Stripe link is a change.
  const refused = await impersonationRefusalResponse(user)
  if (refused) return refused
  const page = PAYOUTS_PAGES[from]
  const back = (query = "") => redirectResponse(absoluteUrl(`${page.page}${query}`))
  if (!canManageOwnAccount(user)) return back()

  const db = getDb()
  if (!(await findStripeAccountByUser(db, user.id))) return back()
  try {
    const url = await createOnboardingLink(db, user, {
      returnPath: page.returnPath,
      refreshPath: page.refreshPath,
    })
    return redirectResponse(url)
  } catch (error) {
    reportError(error, { tags: { route: "payouts.refresh" } })
    return back("?error=link")
  }
}

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: url, "Cache-Control": "no-store" },
  })
}
