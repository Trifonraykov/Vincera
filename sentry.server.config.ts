import * as Sentry from "@sentry/nextjs"

import { env } from "@/lib/env"

import { sharedSentryOptions } from "./sentry.shared"

// Node.js runtime (loaded from instrumentation.ts). Without SENTRY_DSN the SDK is never
// initialised, so every Sentry call in the app is a no-op (§19.3).
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.APP_ENV,
    ...sharedSentryOptions,
  })
}
