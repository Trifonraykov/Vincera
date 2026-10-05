"use client"

import posthog from "posthog-js"
import { PostHogProvider } from "posthog-js/react"
import type { ReactNode } from "react"

import { publicEnv } from "@/lib/public-env"

/**
 * Makes `usePostHog()` and feature-flag hooks available to client components. PostHog itself is
 * initialised in `instrumentation-client.ts`; without NEXT_PUBLIC_POSTHOG_KEY this renders its
 * children unchanged and nothing is sent.
 */
export function AnalyticsProvider({ children }: { children: ReactNode }) {
  if (!publicEnv.NEXT_PUBLIC_POSTHOG_KEY) return children
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>
}
