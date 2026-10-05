import "server-only"

import { eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"

import type { DbOrTx } from "@/lib/db/client"
import { handles } from "@/lib/db/schema"

/**
 * Public profiles (`/c/[handle]`, `/b/[handle]`) are cached for a few minutes (ISR). After their
 * social data changes, ask Next.js to rebuild them on the next visit. Best effort: outside a
 * Next.js request (scripts, tests, some background contexts) there is nothing to revalidate and
 * the pages simply expire on their own.
 */
export function publicProfilePaths(handle: string): string[] {
  return [`/c/${handle}`, `/b/${handle}`]
}

export async function revalidatePublicProfiles(database: DbOrTx, userId: string): Promise<void> {
  const rows = await database
    .select({ handle: handles.handle })
    .from(handles)
    .where(eq(handles.userId, userId))
  for (const { handle } of rows) {
    for (const path of publicProfilePaths(handle)) {
      try {
        revalidatePath(path)
      } catch {
        // Not inside a Next.js request (e.g. tests, scripts): the page's own revalidate applies.
      }
    }
  }
}
