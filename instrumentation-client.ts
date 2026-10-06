import * as Sentry from "@sentry/nextjs"
import posthog from "posthog-js"

import { redactPostHogEvent } from "@/lib/analytics/posthog-client"
import { publicEnv } from "@/lib/public-env"

import { sharedSentryOptions } from "./sentry.shared"

// Runs in the browser before the app hydrates. Both SDKs stay uninitialised (no-op) unless
// their public key is set: SENTRY_DSN at build time (copied by next.config.ts) and
// NEXT_PUBLIC_POSTHOG_KEY.

if (publicEnv.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: publicEnv.NEXT_PUBLIC_SENTRY_DSN,
    ...sharedSentryOptions,
  })
}

if (publicEnv.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(publicEnv.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: publicEnv.NEXT_PUBLIC_POSTHOG_HOST,
    defaults: "2026-08-30",
    // Product analytics only: anonymous until identified, no session replay, no input values.
    person_profiles: "identified_only",
    disable_session_recording: true,
    // Buyer access tokens and Checkout session ids never leave the browser (CLAUDE.md §19.37).
    before_send: redactPostHogEvent,
  })
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
