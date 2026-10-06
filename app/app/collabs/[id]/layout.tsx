import { notFound } from "next/navigation"
import type { ReactNode } from "react"
import { z } from "zod"

import { canViewCollab } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { loadCollabSummary } from "@/lib/collabs/queries"
import { getDb } from "@/lib/db/client"

/**
 * Members and admins only (§6). The check runs here, outside every `loading.tsx` Suspense
 * boundary, so a stranger gets a real 404 status: `notFound()` inside a streamed page can only
 * render the not-found UI with status 200 (CLAUDE.md §19.29). The pages check again themselves.
 */
export default async function CollabLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const collab = await loadCollabSummary(getDb(), id)
  if (!collab || !canViewCollab(user, collab)) notFound()
  return children
}
