import { notFound } from "next/navigation"
import type { ReactNode } from "react"
import { z } from "zod"

import { canViewProduct } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { findProduct } from "@/lib/products/queries"

/**
 * Drafts only for their owner, listed products for everyone signed in (`canViewProduct`). Checked
 * here, outside the `loading.tsx` Suspense boundary, so a hidden product answers a real 404
 * status (CLAUDE.md §19.29); the page checks again itself.
 */
export default async function ProductLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const product = await findProduct(getDb(), id)
  if (
    !product ||
    !canViewProduct(user, { ownerUserId: product.owner.userId, status: product.status })
  ) {
    notFound()
  }
  return children
}
