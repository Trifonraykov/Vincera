import * as Sentry from "@sentry/nextjs"
import type { Instrumentation } from "next"

import { withoutQuery } from "./sentry.shared"

/** Runs once when a server instance starts (never during `next build`). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fail fast on a broken configuration (§17): the server refuses to start.
    const { validateEnvAtBoot } = await import("@/lib/env")
    validateEnvAtBoot()
    await import("./sentry.server.config")
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config")
  }
}

/**
 * Errors thrown while rendering or handling a request. Next passes the raw URL, query string
 * included (magic-link tokens, signed storage URLs, OAuth codes), and Sentry would store it as
 * `contexts.nextjs.request_path`; only the path is sent.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  Sentry.captureRequestError(error, { ...request, path: withoutQuery(request.path) }, context)
}
