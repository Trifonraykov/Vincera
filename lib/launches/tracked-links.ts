import "server-only"

import { and, eq } from "drizzle-orm"

import { generateLinkCode } from "@/lib/attribution/code"
import type { Tx } from "@/lib/db/client"
import { trackedLinks } from "@/lib/db/schema"
import { track } from "@/lib/events/track"

/**
 * Tracked links (§5 `tracked_links`, §10, §12 "Going live creates a default tracked link for the
 * creator"). Codes are 8 random base62 characters (lib/attribution/code.ts); a collision with an
 * existing code (≈ 1 in 10^14 per pair) is retried with a new one.
 *
 * Links with discount codes and the links page are Phase 7 (`/app/launches/[id]/links`, v1); the
 * Stripe promotion code gateway they need is built (lib/stripe/{live,fake}-promotions.ts).
 */

const CODE_ATTEMPTS = 5

/** `/r/<code>`: the path a tracked link is shared as. */
export function trackedLinkPath(code: string): string {
  return `/r/${code}`
}

/**
 * The creator's default link for a launch, created the first time it goes live (inside the
 * go-live transaction, under the launch's row lock): returns the existing one when it is there.
 */
export async function ensureDefaultTrackedLink(
  tx: Tx,
  input: { launchId: string; ownerUserId: string; actorUserId: string | null },
): Promise<{ id: string; code: string; created: boolean }> {
  const [existing] = await tx
    .select({ id: trackedLinks.id, code: trackedLinks.code })
    .from(trackedLinks)
    .where(and(eq(trackedLinks.launchId, input.launchId), eq(trackedLinks.isDefault, true)))
  if (existing) return { ...existing, created: false }

  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const [link] = await tx
      .insert(trackedLinks)
      .values({
        launchId: input.launchId,
        ownerUserId: input.ownerUserId,
        code: generateLinkCode(),
        label: "Default",
        isDefault: true,
      })
      .onConflictDoNothing({ target: trackedLinks.code })
      .returning({ id: trackedLinks.id, code: trackedLinks.code })
    if (!link) continue
    await track(
      "tracked_link.created",
      {
        actorUserId: input.actorUserId,
        subjectType: "tracked_link",
        subjectId: link.id,
        properties: { launch_id: input.launchId, is_default: true, has_discount: false },
      },
      tx,
    )
    return { ...link, created: true }
  }
  throw new Error("Could not find a free tracked link code")
}
