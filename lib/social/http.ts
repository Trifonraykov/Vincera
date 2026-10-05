import "server-only"

import type { z } from "zod"

import { SocialProviderError, SocialRetryableError, SocialTokenError } from "./errors"
import type { SocialProviderId } from "./types"

/**
 * HTTP plumbing shared by the social providers (§7.1).
 *
 * Every provider call goes through an injectable `SocialFetch`: live mode uses `fetch` with a
 * timeout; fake mode (lib/social/fake/transport.ts) serves recorded responses, so the same
 * request building, error classification and Zod parsing runs in dev, e2e and tests.
 *
 * Error messages carry the endpoint label and HTTP status only. Never put a URL with its query
 * string (Instagram sends the token there), a request body or a response body in an error.
 */

/** The subset of `fetch` providers use. Bodies are always strings. */
export type SocialFetch = (url: string, init: SocialRequestInit) => Promise<Response>
export type SocialRequestInit = {
  method: "GET" | "POST"
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}

const LIVE_TIMEOUT_MS = 20_000

/** `fetch` with a timeout and no caching (Next.js must never cache provider responses). */
export const liveSocialFetch: SocialFetch = (url, init) =>
  fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(LIVE_TIMEOUT_MS),
    cache: "no-store",
  })

/**
 * How a failed call is treated: `token` → SocialTokenError (reconnect), `rate_limited` and
 * `unavailable` → SocialRetryableError (retry later), `fatal` → SocialProviderError.
 */
export type ErrorKind = "token" | "rate_limited" | "unavailable" | "fatal"

/** What every provider factory takes (lib/social/registry.ts builds it from env). */
export type ProviderConfig = {
  clientId: string
  clientSecret: string
  /** Our callback, `<app>/api/oauth/<provider>/callback`; must match the provider's settings. */
  redirectUri: string
  fetch: SocialFetch
  /** Authorization endpoint override: the dev fake authorize page in fake mode. */
  authorizeUrl?: string
  /** Defaults to lib/clock `now()`. */
  now?: () => Date
  /** Sent as User-Agent where the provider requires one (GitHub). */
  userAgent?: string
}

export type HttpRequest = {
  /** Short endpoint name for errors and logs, e.g. `channels.list`. */
  label: string
  method: "GET" | "POST"
  /** Endpoint URL without a query string. */
  url: string
  query?: Record<string, string | number | undefined>
  bearer?: string
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string | undefined>
  /** JSON body. */
  json?: unknown
  headers?: Record<string, string>
}

export type HttpFailure = {
  status: number
  body: unknown
  headers: Headers
  request: HttpRequest
}

export type HttpClient = {
  provider: SocialProviderId
  fetch: SocialFetch
  /** Provider-specific classification of a non-2xx response; undefined = use the default. */
  classify?: (failure: HttpFailure) => ErrorKind | undefined
}

/** The full URL of a request (with its query). For transports only; never log it. */
export function requestUrl(request: Pick<HttpRequest, "url" | "query">): string {
  const url = new URL(request.url)
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

function buildInit(request: HttpRequest): SocialRequestInit {
  const headers: Record<string, string> = { Accept: "application/json", ...request.headers }
  if (request.bearer) headers.Authorization = `Bearer ${request.bearer}`
  let body: string | undefined
  if (request.form) {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(request.form)) {
      if (value !== undefined) form.set(key, value)
    }
    body = form.toString()
    headers["Content-Type"] = "application/x-www-form-urlencoded"
  } else if (request.json !== undefined) {
    body = JSON.stringify(request.json)
    headers["Content-Type"] = "application/json"
  }
  return { method: request.method, headers, body }
}

/** Default classification: 401 → token, 429 → rate limited, 408/425/5xx → unavailable. */
export function defaultErrorKind(status: number): ErrorKind {
  if (status === 401) return "token"
  if (status === 429) return "rate_limited"
  if (status === 408 || status === 425 || status >= 500) return "unavailable"
  return "fatal"
}

/** Seconds from a Retry-After header (seconds form only), else undefined. */
function retryAfter(headers: Headers): number | undefined {
  const header = headers.get("retry-after")?.trim()
  // Number("") is 0, so an absent or empty header must not reach Number().
  if (!header || !/^\d+$/.test(header)) return undefined
  return Number(header)
}

/** The error to throw for a classified failure. */
export function failure(
  client: Pick<HttpClient, "provider">,
  kind: ErrorKind,
  label: string,
  status: number,
  options: { retryAfterSeconds?: number } = {},
): Error {
  const message = `${client.provider} ${label} failed (HTTP ${status})`
  switch (kind) {
    case "token":
      return new SocialTokenError(client.provider, `${message}: token rejected`)
    case "rate_limited":
    case "unavailable":
      return new SocialRetryableError(client.provider, kind, message, {
        status,
        retryAfterSeconds: options.retryAfterSeconds,
      })
    case "fatal":
      return new SocialProviderError(client.provider, "provider_error", message, status)
  }
}

/** Zod issue paths and codes only: issue messages could echo provider values. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
    .join("; ")
}

/** Parse `value` with `schema`, or throw `invalid_response` naming the endpoint. */
export function parseResponse<S extends z.ZodType>(
  client: Pick<HttpClient, "provider">,
  label: string,
  schema: S,
  value: unknown,
): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new SocialProviderError(
      client.provider,
      "invalid_response",
      `${client.provider} ${label}: unexpected response (${describeIssues(parsed.error)})`,
    )
  }
  return parsed.data
}

export type RawResponse = { status: number; headers: Headers; body: unknown }

/**
 * Send a request and return the status, headers and parsed JSON body, whatever the status.
 * Network failures and timeouts become `SocialRetryableError`.
 */
export async function send(client: HttpClient, request: HttpRequest): Promise<RawResponse> {
  let response: Response
  try {
    response = await client.fetch(requestUrl(request), buildInit(request))
  } catch (error) {
    // The cause is dropped on purpose: fetch errors can include the request URL.
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed"
    throw new SocialRetryableError(
      client.provider,
      "unavailable",
      `${client.provider} ${request.label} ${reason} (network)`,
    )
  }
  const text = await response.text()
  let body: unknown = undefined
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = undefined
    }
  }
  return { status: response.status, headers: response.headers, body }
}

/** Throw the classified error for a non-2xx response. */
export function throwForStatus(client: HttpClient, request: HttpRequest, raw: RawResponse): never {
  const kind =
    client.classify?.({ status: raw.status, body: raw.body, headers: raw.headers, request }) ??
    defaultErrorKind(raw.status)
  throw failure(client, kind, request.label, raw.status, {
    retryAfterSeconds: retryAfter(raw.headers),
  })
}

/**
 * Run a code exchange: a rejected grant there means the authorization code was bad or expired,
 * not that a stored token died, so `SocialTokenError` becomes `invalid_code`.
 */
export async function asCodeExchange<T>(
  provider: SocialProviderId,
  exchange: () => Promise<T>,
): Promise<T> {
  try {
    return await exchange()
  } catch (error) {
    if (error instanceof SocialTokenError) {
      throw new SocialProviderError(
        provider,
        "invalid_code",
        `${provider} rejected the authorization code`,
      )
    }
    throw error
  }
}

/** Space- or comma-separated scope list → array. */
export function splitScopes(value: string | readonly string[] | null | undefined): string[] {
  if (!value) return []
  const list = typeof value === "string" ? value.split(/[\s,]+/) : [...value]
  return list.map((scope) => scope.trim()).filter(Boolean)
}

/** Expiry `seconds` after `at`, or null when the provider gives none. */
export function expiresIn(at: Date, seconds: number | null | undefined): Date | null {
  return seconds && seconds > 0 ? new Date(at.getTime() + seconds * 1000) : null
}

/** Send a request, map non-2xx statuses to errors, and Zod-parse the JSON body. */
export async function requestJson<S extends z.ZodType>(
  client: HttpClient,
  request: HttpRequest,
  schema: S,
): Promise<z.output<S>> {
  const raw = await send(client, request)
  if (raw.status < 200 || raw.status > 299) throwForStatus(client, request, raw)
  return parseResponse(client, request.label, schema, raw.body)
}
