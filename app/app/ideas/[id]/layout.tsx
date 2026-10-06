import { notFound } from "next/navigation"
import type { ReactNode } from "react"
import { z } from "zod"

import { canViewIdea } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { findIdea } from "@/lib/ideas/queries"

/**
 * Drafts only for their owner, published ideas for everyone signed in (`canViewIdea`). Checked
 * here, outside the `loading.tsx` Suspense boundary, so a hidden idea answers a real 404 status
 * (CLAUDE.md §19.29); the page checks again itself.
 */
export default async function IdeaLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const idea = await findIdea(getDb(), id)
  if (!idea || !canViewIdea(user, { ownerUserId: idea.owner.userId, status: idea.status })) {
    notFound()
  }
  return children
}
