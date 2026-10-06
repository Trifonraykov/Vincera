import "server-only"

import { z } from "zod"

import { ActionError } from "@/lib/actions/errors"
import { isActive } from "@/lib/auth/authz"
import type { AuthUser } from "@/lib/auth/user"
import { getDb, type Db } from "@/lib/db/client"
import { isProduction } from "@/lib/env"
import { reportError } from "@/lib/observability"
import { resolveOnboardingRedirect } from "@/lib/onboarding/gate"

import { MESSAGE_MESSAGES } from "@/lib/messages/post"
import { PROPOSAL_MESSAGES } from "@/lib/proposals/service"

import { MOBILE_MESSAGES, MobileApiError } from "./errors"
import { MOBILE_API_PREFIX, type ApiError } from "./schemas"
import { bearerToken, findMobileSessionUser } from "./sessions"

/**
 * The mobile API's small router (CLAUDE.md §19.44). One catch-all route handler
 * (`app/api/mobile/v1/[...path]/route.ts`) hands every request here; each endpoint declares its
 * method, path, who may call it, and the Zod schemas of its input and output (from ./schemas.ts,
 * shared with the app). The recipe mirrors `defineAction` (§4):
 *
 * 1. parse the body and query with Zod (400 with field errors);
 * 2. authenticate the bearer token (401), refuse suspended accounts (403), and for most endpoints
 *    unfinished onboarding (403 `onboarding_required`, like the web's `/app` gate);
 * 3. `run` calls the same authz rules and services as the web's pages and server actions, which
 *    write the same events in the same transactions;
 * 4. the result is serialised (dates → ISO strings) and checked against the output schema, which
 *    also drops any field the contract does not name.
 *
 * `ActionError`s from the shared services become 422 `refused` with their plain-language message.
 */

export type AuthMode = "public" | "user" | "onboarded"

const SERVICE_RATE_LIMIT_MESSAGES = new Set<string>([
  PROPOSAL_MESSAGES.rateLimited,
  MESSAGE_MESSAGES.rateLimited,
])

function cleanFieldErrors(
  fieldErrors: Partial<Record<string, string[]>> | undefined,
): Record<string, string[]> | undefined {
  if (!fieldErrors) return undefined
  const entries = Object.entries(fieldErrors).filter(
    (entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].length > 0,
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export type EndpointContext<Input, Query> = {
  request: Request
  params: Record<string, string>
  input: Input
  query: Query
  db: Db
}

type AuthedContext<Input, Query> = EndpointContext<Input, Query> & {
  user: AuthUser
  token: string
}

type AnySchema = z.ZodType
const EMPTY = z.object({}).optional()
type Empty = typeof EMPTY

export type Endpoint = {
  method: Method
  path: string
  auth: AuthMode
  input: AnySchema
  query: AnySchema
  output: AnySchema
  run: (
    context: AuthedContext<unknown, unknown> | EndpointContext<unknown, unknown>,
  ) => Promise<unknown>
}

type Definition<
  I extends AnySchema,
  Q extends AnySchema,
  O extends AnySchema,
  A extends AuthMode,
> = {
  method: Method
  path: string
  auth: A
  input?: I
  query?: Q
  output: O
  run: (
    context: A extends "public"
      ? EndpointContext<z.output<I>, z.output<Q>>
      : AuthedContext<z.output<I>, z.output<Q>>,
  ) => Promise<z.input<O> | Record<string, unknown>>
}

export function endpoint<
  A extends AuthMode,
  O extends AnySchema,
  I extends AnySchema = Empty,
  Q extends AnySchema = Empty,
>(definition: Definition<I, Q, O, A>): Endpoint {
  return {
    method: definition.method,
    path: definition.path,
    auth: definition.auth,
    input: definition.input ?? EMPTY,
    query: definition.query ?? EMPTY,
    output: definition.output,
    run: definition.run as Endpoint["run"],
  }
}

// --- Responses ------------------------------------------------------------------------------------

function corsHeaders(): Record<string, string> {
  // Bearer tokens, no cookies: allowing any origin enables nothing a token-less page could abuse.
  // Only outside production, for the react-native-web preview (CLAUDE.md §19.44).
  if (isProduction()) return {}
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600",
  }
}

export function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
      ...extra,
    },
  })
}

function errorResponse(error: MobileApiError): Response {
  const body: ApiError = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
    },
  }
  const headers: Record<string, string> = {}
  if (error.retryAfterSeconds) headers["Retry-After"] = String(error.retryAfterSeconds)
  if (error.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="mobile"'
  return jsonResponse(body, error.status, headers)
}

function invalidInput(error: z.ZodError): MobileApiError {
  const { formErrors, fieldErrors } = z.flattenError(error)
  const fields = Object.fromEntries(
    Object.entries(fieldErrors).filter((entry): entry is [string, string[]] =>
      Array.isArray(entry[1]),
    ),
  )
  return new MobileApiError(
    400,
    "invalid_input",
    formErrors[0] ?? MOBILE_MESSAGES.invalidInput,
    Object.keys(fields).length > 0 ? fields : undefined,
  )
}

/** Run a domain form schema (the web's) and turn its issues into a 400 with field errors. */
export function parseForm<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw invalidInput(parsed.error)
  return parsed.data
}

// --- Matching -------------------------------------------------------------------------------------

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean)
  const have = path.split("/").filter(Boolean)
  if (want.length !== have.length) return null
  const params: Record<string, string> = {}
  for (const [index, part] of want.entries()) {
    const value = have[index] ?? ""
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(value)
    else if (part !== value) return null
  }
  return params
}

async function readBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") return {}
  const text = await request.text()
  if (text.trim() === "") return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new MobileApiError(400, "invalid_input", "The request body is not valid JSON.")
  }
}

export type RouterDeps = { db?: Db }

async function authenticate(request: Request, db: Db, mode: AuthMode) {
  const token = bearerToken(request.headers)
  const session = token ? await findMobileSessionUser(db, token) : null
  if (!token || !session) {
    throw new MobileApiError(401, "unauthorized", MOBILE_MESSAGES.unauthorized)
  }
  if (!isActive(session.user)) {
    throw new MobileApiError(403, "suspended", MOBILE_MESSAGES.suspended)
  }
  if (mode === "onboarded" && (await resolveOnboardingRedirect(session.user, db)) !== null) {
    throw new MobileApiError(403, "onboarding_required", MOBILE_MESSAGES.onboarding)
  }
  return { user: session.user, token }
}

/** Dispatch one request to its endpoint. */
export async function handleMobileRequest(
  request: Request,
  endpoints: readonly Endpoint[],
  deps: RouterDeps = {},
): Promise<Response> {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders() })

  const pathname = new URL(request.url).pathname
  const path = pathname.startsWith(MOBILE_API_PREFIX)
    ? pathname.slice(MOBILE_API_PREFIX.length) || "/"
    : pathname
  const candidates = endpoints
    .map((candidate) => ({ endpoint: candidate, params: matchPath(candidate.path, path) }))
    .filter((entry) => entry.params !== null)
  const found = candidates.find((entry) => entry.endpoint.method === request.method)
  if (!found?.params) {
    return candidates.length > 0
      ? jsonResponse({ error: { code: "not_found", message: "Method not allowed." } }, 405, {
          Allow: candidates.map((entry) => entry.endpoint.method).join(", "),
        })
      : errorResponse(new MobileApiError(404, "not_found", MOBILE_MESSAGES.notFound))
  }
  const { endpoint: route, params } = found

  try {
    const db = deps.db ?? getDb()
    const body = await readBody(request)
    const input = route.input.safeParse(body)
    if (!input.success) throw invalidInput(input.error)
    const query = route.query.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success) throw invalidInput(query.error)

    const base = { request, params, input: input.data, query: query.data, db }
    const context =
      route.auth === "public" ? base : { ...base, ...(await authenticate(request, db, route.auth)) }
    const result = await route.run(context)

    // Dates become ISO strings; the schema then checks the wire format and drops extra fields.
    const wire: unknown = JSON.parse(JSON.stringify(result ?? {}))
    const output = route.output.safeParse(wire)
    if (!output.success) {
      reportError(new Error(`Mobile API output failed its schema: ${route.method} ${route.path}`), {
        tags: { area: "mobile-api" },
        extra: { issues: output.error.issues.slice(0, 5).map((issue) => issue.path.join(".")) },
      })
      throw new MobileApiError(500, "internal", MOBILE_MESSAGES.unexpected)
    }
    return jsonResponse(output.data)
  } catch (error) {
    if (error instanceof MobileApiError) return errorResponse(error)
    if (error instanceof ActionError) {
      // The services' own limits (20 proposals a day, 30 messages a minute, §14) refuse with an
      // ActionError; the app gets them as 429 so it can say "try again later".
      const limited = SERVICE_RATE_LIMIT_MESSAGES.has(error.message)
      return errorResponse(
        new MobileApiError(
          limited ? 429 : 422,
          limited ? "rate_limited" : "refused",
          error.message,
          cleanFieldErrors(error.fieldErrors),
        ),
      )
    }
    reportError(error, { tags: { area: "mobile-api", endpoint: `${route.method} ${route.path}` } })
    return errorResponse(new MobileApiError(500, "internal", MOBILE_MESSAGES.unexpected))
  }
}

/** A UUID path parameter, or a 404 (strangers learn nothing from a malformed id either). */
export function uuidParam(params: Record<string, string>, name = "id"): string {
  const value = params[name]
  if (!value || !z.uuid().safeParse(value).success) {
    throw new MobileApiError(404, "not_found", MOBILE_MESSAGES.notFound)
  }
  return value
}
