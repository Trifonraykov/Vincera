import "server-only"

import { revalidatePath } from "next/cache"

/**
 * `/p/[slug]` is static and revalidated on demand (§12): call this after a commit that changes
 * what the page shows (going live, pause, resume, end, an edit of a paused launch). Best effort:
 * outside a Next.js request (tests, scripts) there is nothing to revalidate.
 */
export function launchPagePath(slug: string): string {
  return `/p/${slug}`
}

export function revalidateLaunchPage(slug: string): void {
  try {
    revalidatePath(launchPagePath(slug))
  } catch {
    // Not inside a Next.js request: the page's own revalidate applies.
  }
}
