import { notFound } from "next/navigation"
import type { ReactNode } from "react"
import { z } from "zod"

import { canViewLaunchLinks } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { loadLaunchAccess } from "@/lib/launches/queries"

/**
 * The launch's members and admins only. The check runs here, outside the page's `loading.tsx`
 * Suspense boundary, so a stranger gets a real 404 status (CLAUDE.md §19.29). The page checks
 * again itself.
 */
export default async function LaunchLinksLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const access = await loadLaunchAccess(getDb(), id)
  if (!access || !canViewLaunchLinks(user, access)) notFound()
  return children
}
