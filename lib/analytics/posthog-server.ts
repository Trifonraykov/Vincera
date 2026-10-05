import "server-only"

import { PostHog } from "posthog-node"

import { env } from "@/lib/env"
import { reportError } from "@/lib/observability"

/**
 * Server-side PostHog (product analytics, §2). A no-op without NEXT_PUBLIC_POSTHOG_KEY.
 *
 * Product analytics are separate from the business event log (`lib/events/track.ts`, §11): the
 * event log is the source of truth and must be written regardless; PostHog is for funnels and
 * dashboards. The same privacy rules apply: no emails, tokens or message bodies in properties.
 */

let client: PostHog | null | undefined

export function getPostHogServer(): PostHog | null {
  if (client === undefined) {
    const key = env.NEXT_PUBLIC_POSTHOG_KEY
    // Serverless-friendly: send each event immediately instead of batching in memory.
    client = key
      ? new PostHog(key, { host: env.NEXT_PUBLIC_POSTHOG_HOST, flushAt: 1, flushInterval: 0 })
      : null
  }
  return client
}

/** Capture one event and wait until it is sent. Never throws. */
export async function captureServerEvent(input: {
  /** The user id (never an email). */
  distinctId: string
  event: string
  properties?: Record<string, string | number | boolean | null>
}): Promise<void> {
  const posthog = getPostHogServer()
  if (!posthog) return
  try {
    await posthog.captureImmediate({
      distinctId: input.distinctId,
      event: input.event,
      properties: input.properties,
    })
  } catch (error) {
    reportError(error, { tags: { analytics: "posthog" } })
  }
}
