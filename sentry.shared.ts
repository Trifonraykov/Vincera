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

/**
 * Drizzle's failed-query message ends with "params: <values>" (emails, names, encrypted tokens).
 * Same rule as `redactQueryParams` in lib/db/errors.ts, repeated here because this file is shared
 * with the browser and edge SDKs and must not import server code.
 */
export function withoutQueryParams(text: string): string {
  return text.replace(/(Failed query: [\s\S]*?\nparams: )[\s\S]*$/, "$1[redacted]")
}

type BreadcrumbLike = {
  category?: string
  message?: string
  data?: { [key: string]: unknown }
}

type SentryEventLike = {
  contexts?: { [name: string]: Record<string, unknown> | undefined }
  exception?: { values?: { value?: string }[] }
  breadcrumbs?: BreadcrumbLike[]
  message?: string
}

/**
 * Breadcrumbs lose failed-query parameters too. The console integration (on by default) records
 * every console call as `{ message, data: { arguments } }` with the raw arguments; an Error among
 * them is serialised with its own properties, and a `DrizzleQueryError` has `query` and `params`
 * (emails, names, encrypted tokens). Next logs errors thrown from pages and route handlers that
 * way, outside `reportError`. So console breadcrumbs keep only their formatted message, scrubbed
 * like everything else. Installed as `beforeBreadcrumb`, and applied again in `beforeSend`.
 */
export function scrubBreadcrumb<Breadcrumb extends BreadcrumbLike>(
  breadcrumb: Breadcrumb,
): Breadcrumb {
  if (typeof breadcrumb.message === "string") {
    breadcrumb.message = withoutQueryParams(breadcrumb.message)
  }
  if (breadcrumb.category === "console" && breadcrumb.data && "arguments" in breadcrumb.data) {
    const { arguments: _arguments, ...data } = breadcrumb.data
    breadcrumb.data = data
  }
  return breadcrumb
}

/**
 * Last line of defence before an event leaves the app.
 * - `dataCollection.urlQueryParams` filters the URLs Sentry collects itself (request, spans,
 *   breadcrumbs), but not the request path the Next.js integration copies into `contexts.nextjs`
 *   (instrumentation.ts also strips it there).
 * - Database errors that reach Sentry without `reportError` (an error thrown out of a page or a
 *   route handler, or logged and picked up as a console breadcrumb) lose their query parameters
 *   (`scrubBreadcrumb` for breadcrumbs, including the console's raw arguments).
 */
export function scrubEvent<Event extends SentryEventLike>(event: Event): Event {
  const nextjs = event.contexts?.nextjs
  if (nextjs && typeof nextjs.request_path === "string") {
    nextjs.request_path = withoutQuery(nextjs.request_path)
  }
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === "string") exception.value = withoutQueryParams(exception.value)
  }
  for (const breadcrumb of event.breadcrumbs ?? []) scrubBreadcrumb(breadcrumb)
  if (typeof event.message === "string") event.message = withoutQueryParams(event.message)
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
  beforeBreadcrumb: scrubBreadcrumb,
}
