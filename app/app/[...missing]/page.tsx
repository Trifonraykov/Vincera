import { notFound } from "next/navigation"

import { requireOnboardedUser } from "@/lib/auth/session"

/**
 * Any `/app/*` path without a page of its own (a §12 page a later phase builds, or a mistyped
 * URL). Next renders unmatched URLs with the root not-found, outside this layout; routing them
 * here keeps the app shell (sidebar, tab bar) around app/app/not-found.tsx.
 */
export default async function MissingAppPage() {
  await requireOnboardedUser()
  notFound()
}
