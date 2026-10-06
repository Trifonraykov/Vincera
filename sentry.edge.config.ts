import * as Sentry from "@sentry/nextjs"

import { sharedSentryOptions } from "./sentry.shared"

// Edge runtime (proxy.ts, edge routes). lib/env is Node-only, so read process.env directly.
// Without SENTRY_DSN the SDK is never initialised and Sentry calls are no-ops.
const dsn = process.env.SENTRY_DSN?.trim()

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.APP_ENV ?? process.env.NODE_ENV,
    ...sharedSentryOptions,
  })
}
