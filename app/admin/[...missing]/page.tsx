import { notFound } from "next/navigation"

import { requireAdmin } from "@/lib/auth/session"

/** Any `/admin/*` path without a page of its own; see app/app/[...missing]/page.tsx. */
export default async function MissingAdminPage() {
  await requireAdmin()
  notFound()
}
