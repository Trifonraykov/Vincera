/**
 * Sentry options shared by the server, edge and browser SDKs.
 *
 * Sentry's defaults collect user info, cookies, headers, bodies, query strings and AI
 * inputs/outputs. We send none of that: URLs and bodies can carry access tokens, OAuth codes,
 * emails and messages, which must never leave the app (§11, §14).
 */

/** A URL or path without its query string and fragment (magic-link tokens, signatures, codes). */
export function withoutQuery(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? ""
}

type SentryEventLike = { contexts?: { [name: string]: Record<string, unknown> | undefined } }

/**
 * Last line of defence before an event leaves the app. `dataCollection.urlQueryParams` filters
 * the URLs Sentry collects itself (request, spans, breadcrumbs), but not the request path the
 * Next.js integration copies into `contexts.nextjs` (instrumentation.ts also strips it there).
 */
export function scrubEvent<Event extends SentryEventLike>(event: Event): Event {
  const nextjs = event.contexts?.nextjs
  if (nextjs && typeof nextjs.request_path === "string") {
    nextjs.request_path = withoutQuery(nextjs.request_path)
  }
  return event
}

export const sharedSentryOptions = {
  tracesSampleRate: 0.1,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: false,
  },
  beforeSend: scrubEvent,
}
