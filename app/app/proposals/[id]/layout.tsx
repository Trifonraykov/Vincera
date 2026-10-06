import { notFound } from "next/navigation"
import type { ReactNode } from "react"
import { z } from "zod"

import { canViewProposal } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { loadProposalDetail } from "@/lib/proposals/queries"

/**
 * The two parties and admins only. Checked here, outside the `loading.tsx` Suspense boundary, so
 * anyone else gets a real 404 status (CLAUDE.md §19.29); the page checks again itself.
 */
export default async function ProposalLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const detail = await loadProposalDetail(getDb(), id)
  if (!detail || !canViewProposal(user, detail.access)) notFound()
  return children
}
