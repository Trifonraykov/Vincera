import { eq } from "drizzle-orm"
import NextAuth from "next-auth"
import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { POST as authRoutePOST } from "@/app/api/auth/[...nextauth]/route"
import { configuredOAuthProviders, createAuthConfig, signUpMethodFrom } from "@/lib/auth/config"
import { EMAIL_CALLBACK_RATE_LIMIT, prepareEmailCallback } from "@/lib/auth/email-callback"
import { PENDING_NAME_COOKIE, withPendingNameCleared } from "@/lib/auth/pending-name"
import { parseAuthUser } from "@/lib/auth/user"
import { events, sessions, users, verificationTokens } from "@/lib/db/schema"
import { parseEnv } from "@/lib/env"
import { RATE_LIMITS, resetMemoryRateLimits } from "@/lib/ratelimit"

import { setupTestDatabase } from "../../helpers/db"
import { insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"

/**
 * The real Auth.js request handlers running our config (adapter, providers, callbacks) against a
 * test database: magic-link sign-up and sign-in, the session payload, suspension, sign-out, the
 * §14 rate limit and the OAuth checks. Only the email transport is replaced, to capture the
 * magic link. Requests go straight to Auth.js's endpoints, like the in-process calls our server
 * actions make (the route itself closes POST /api/auth/signin/*; see the last tests).
 */

const sent = vi.hoisted(() => [] as { to: string; url: string; code?: string }[])
vi.mock("@/lib/email/magic-link", () => ({
  sendMagicLinkEmail: async (input: { to: string; url: string; code?: string }) => {
    sent.push(input)
    return { id: "test" }
  },
}))

const testDb = setupTestDatabase()

const BASE_URL = "http://localhost:3000"
const ADMIN_EMAIL = "chief@example.test"

const env = parseEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/unused",
  AUTH_SECRET: "integration-test-auth-secret-0123456789",
  ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  STRIPE_WEBHOOK_SECRET: "whsec_integration",
  ADMIN_EMAILS: ADMIN_EMAIL,
})

const { handlers } = NextAuth((request) => createAuthConfig(request, { db: testDb.db, env }))
type AuthHandlers = typeof handlers

/** A minimal cookie jar for a sequence of requests, from one client IP. */
class Browser {
  readonly cookies = new Map<string, string>()

  constructor(
    private readonly ip?: string,
    private readonly auth: AuthHandlers = handlers,
  ) {}

  async request(
    method: "GET" | "POST",
    path: string,
    form?: Record<string, string>,
  ): Promise<Response> {
    const headers = new Headers()
    if (this.ip) headers.set("x-forwarded-for", this.ip)
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "))
    }
    if (form) headers.set("content-type", "application/x-www-form-urlencoded")
    const raw = new NextRequest(new URL(path, BASE_URL), {
      method,
      headers,
      body: form ? new URLSearchParams(form).toString() : undefined,
    })
    // Same wrapping as app/api/auth/[...nextauth]/route.ts.
    const prepared = method === "GET" ? await prepareEmailCallback(raw) : raw
    if (prepared instanceof Response) return prepared
    const request = prepared
    const response = withPendingNameCleared(
      request,
      await (method === "GET" ? this.auth.GET(request) : this.auth.POST(request)),
    )
    for (const header of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = header.split(";")
      const index = pair.indexOf("=")
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === ""
      if (expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }

  async csrfToken(): Promise<string> {
    const response = await this.request("GET", "/api/auth/csrf")
    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null || !("csrfToken" in body)) {
      throw new Error("no csrf token")
    }
    return String(body.csrfToken)
  }

  /** POST Auth.js's sign-in endpoint for `provider`; returns where Auth.js redirects. */
  async startSignIn(provider: string, form: Record<string, string> = {}): Promise<string> {
    const csrfToken = await this.csrfToken()
    const response = await this.request("POST", `/api/auth/signin/${provider}`, {
      ...form,
      csrfToken,
      callbackUrl: "/app",
    })
    return response.headers.get("location") ?? ""
  }

  /** POST the email sign-in form; returns where Auth.js redirects. */
  requestMagicLink(email: string): Promise<string> {
    return this.startSignIn("email", { email })
  }

  async sessionUser() {
    const response = await this.request("GET", "/api/auth/session")
    const body: unknown = await response.json()
    return body && typeof body === "object" && "user" in body ? parseAuthUser(body.user) : null
  }
}

function lastLink(): string {
  const link = sent.at(-1)?.url
  if (!link) throw new Error("no magic link sent")
  return link
}

beforeEach(() => {
  sent.length = 0
  // The rate limiter reads the process environment: in-memory fake, fresh budgets per test.
  stubServiceEnv()
  resetMemoryRateLimits()
})

describe("magic-link sign-up and sign-in through Auth.js", () => {
  it("signs a new user up, records the event and exposes roles in the session", async () => {
    const browser = new Browser()
    const location = await browser.requestMagicLink("Grace@Example.test")

    // Auth.js's verify-request step forwards to our sign-in page's "check your email" state.
    expect(location).toBe(`${BASE_URL}/api/auth/verify-request?provider=email&type=email`)
    const verify = await browser.request("GET", location)
    expect(verify.headers.get("location")).toBe("/sign-in?provider=email&type=email")
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe("grace@example.test")
    expect(lastLink()).toMatch(/\/api\/auth\/callback\/email\?/)

    // The optional name typed on /sign-up waits in a cookie until the account is created.
    browser.cookies.set(PENDING_NAME_COOKIE, encodeURIComponent("Grace Hopper"))
    const callback = await browser.request("GET", lastLink())
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe(`${BASE_URL}/app`)
    expect(browser.cookies.has("authjs.session-token")).toBe(true)
    expect(browser.cookies.has(PENDING_NAME_COOKIE)).toBe(false)

    const [user] = await testDb.db.select().from(users).where(eq(users.email, "grace@example.test"))
    expect(user).toMatchObject({ name: "Grace Hopper", roles: [], status: "active" })
    expect(user?.emailVerified).toBeInstanceOf(Date)
    if (!user) throw new Error("user not created")

    const signUpEvents = await testDb.db.select().from(events).where(eq(events.subjectId, user.id))
    expect(signUpEvents.map((e) => [e.type, e.properties])).toEqual([
      ["user.signed_up", { method: "email" }],
    ])

    expect(await browser.sessionUser()).toEqual({
      id: user.id,
      email: "grace@example.test",
      name: "Grace Hopper",
      image: null,
      roles: [],
      activeRole: null,
      status: "active",
      onboardingCompletedAt: null,
    })

    // Roles are read from the database on every request, not stored in the session.
    await testDb.db
      .update(users)
      .set({ roles: ["builder"], activeRole: "builder" })
      .where(eq(users.id, user.id))
    expect(await browser.sessionUser()).toMatchObject({ roles: ["builder"], activeRole: "builder" })
  })

  it("signs an existing user in without creating a new account or event", async () => {
    const existing = await insertUser(testDb.db, { email: "linus@example.test" })
    const browser = new Browser()
    await browser.requestMagicLink("linus@example.test")
    await browser.request("GET", lastLink())

    expect((await browser.sessionUser())?.id).toBe(existing.id)
    const rows = await testDb.db.select().from(events).where(eq(events.subjectId, existing.id))
    expect(rows).toEqual([])
  })

  it("grants the admin role to an ADMIN_EMAILS sign-up", async () => {
    const browser = new Browser()
    await browser.requestMagicLink(ADMIN_EMAIL)
    await browser.request("GET", lastLink())
    expect(await browser.sessionUser()).toMatchObject({ email: ADMIN_EMAIL, roles: ["admin"] })
  })

  it("rejects magic links that were already used", async () => {
    const browser = new Browser()
    await browser.requestMagicLink("once@example.test")
    const link = lastLink()
    await browser.request("GET", link)

    const reused = await new Browser().request("GET", link)
    expect(reused.headers.get("location")).toBe(`${BASE_URL}/sign-in?error=Verification`)
  })

  it("signs out by deleting the database session", async () => {
    const browser = new Browser()
    await browser.requestMagicLink("leaving@example.test")
    await browser.request("GET", lastLink())
    const userId = (await browser.sessionUser())?.id
    if (!userId) throw new Error("not signed in")

    const csrfToken = await browser.csrfToken()
    await browser.request("POST", "/api/auth/signout", { csrfToken, callbackUrl: "/" })

    expect(await browser.sessionUser()).toBeNull()
    expect(await testDb.db.select().from(sessions).where(eq(sessions.userId, userId))).toEqual([])
  })
})

describe("suspended users", () => {
  it("cannot request a magic link (no email is sent)", async () => {
    await insertUser(testDb.db, { email: "suspended@example.test", status: "suspended" })
    const location = await new Browser().requestMagicLink("Suspended@example.test")

    expect(location).toBe(`${BASE_URL}/sign-in?error=AccessDenied`)
    expect(sent).toEqual([])
  })

  it("cannot use a link that was sent before the suspension", async () => {
    const user = await insertUser(testDb.db, { email: "later@example.test" })
    const browser = new Browser()
    await browser.requestMagicLink("later@example.test")
    await testDb.db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id))

    const callback = await browser.request("GET", lastLink())
    expect(callback.headers.get("location")).toBe(`${BASE_URL}/sign-in?error=AccessDenied`)
    expect(browser.cookies.has("authjs.session-token")).toBe(false)
  })

  it("show up as suspended in an existing session, so the proxy can lock them out", async () => {
    const browser = new Browser()
    await browser.requestMagicLink("midway@example.test")
    await browser.request("GET", lastLink())
    await testDb.db
      .update(users)
      .set({ status: "suspended" })
      .where(eq(users.email, "midway@example.test"))

    expect(await browser.sessionUser()).toMatchObject({ status: "suspended" })
  })
})

describe("config helpers", () => {
  it("derives the sign-up method from the callback path", () => {
    expect(signUpMethodFrom("/api/auth/callback/email")).toBe("email")
    expect(signUpMethodFrom("/api/auth/callback/google")).toBe("google")
    expect(signUpMethodFrom("/api/auth/callback/github")).toBe("github")
    expect(signUpMethodFrom(undefined)).toBe("email")
  })

  it("registers Google and GitHub only when their credentials are set", () => {
    expect(configuredOAuthProviders(env)).toEqual([])
    const withGitHub = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/unused",
      AUTH_SECRET: "integration-test-auth-secret-0123456789",
      ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
      STRIPE_WEBHOOK_SECRET: "whsec_integration",
      AUTH_GITHUB_ID: "id",
      AUTH_GITHUB_SECRET: "secret",
      AUTH_GOOGLE_ID: "only-id",
    })
    expect(configuredOAuthProviders(withGitHub)).toEqual(["github"])
    const providerIds = createAuthConfig(undefined, {
      db: testDb.db,
      env: withGitHub,
    }).providers.map((provider) => (typeof provider === "function" ? provider().id : provider.id))
    expect(providerIds).toEqual(["email", "github"])
  })
})

describe("rate limiting (§14)", () => {
  const { limit } = RATE_LIMITS.auth
  const LINK_SENT = `${BASE_URL}/api/auth/verify-request?provider=email&type=email`
  const RATE_LIMITED = `${BASE_URL}/sign-in?error=RateLimited`

  /** Verification tokens stored for an address (one per link actually sent). */
  async function tokensFor(email: string) {
    return testDb.db
      .select()
      .from(verificationTokens)
      .where(eq(verificationTokens.identifier, email))
  }

  it("caps magic links per email address, from any number of IPs", async () => {
    for (let i = 1; i <= limit; i++) {
      expect(await new Browser(`2001:db8::a:${i}`).requestMagicLink("target@example.test")).toBe(
        LINK_SENT,
      )
    }
    // Same address after Auth.js's normalisation, from a fresh IP.
    const refused = await new Browser("2001:db8::a:ff").requestMagicLink(" Target@Example.TEST ")
    expect(refused).toBe(RATE_LIMITED)
    expect(sent).toHaveLength(limit)
    expect(await tokensFor("target@example.test")).toHaveLength(limit)
  })

  it("caps magic links per client IP, across addresses", async () => {
    const browser = new Browser("2001:db8::b:1")
    for (let i = 1; i <= limit; i++) {
      expect(await browser.requestMagicLink(`ip-${i}@example.test`)).toBe(LINK_SENT)
    }
    expect(await browser.requestMagicLink("ip-next@example.test")).toBe(RATE_LIMITED)
    expect(sent).toHaveLength(limit)
    expect(await tokensFor("ip-next@example.test")).toEqual([])

    // Another client still gets its link.
    expect(await new Browser("2001:db8::b:2").requestMagicLink("ip-next@example.test")).toBe(
      LINK_SENT,
    )
  })

  it("does not count opening a magic link", async () => {
    const browser = new Browser("2001:db8::c:1")
    await browser.requestMagicLink("clicker@example.test")
    const link = lastLink()
    for (let i = 0; i < limit; i++) await browser.request("GET", link)
    expect(await browser.requestMagicLink("clicker-2@example.test")).toBe(LINK_SENT)
  })
})

describe("sign-in codes (the installed app on iOS, CLAUDE.md §19.19)", () => {
  const RATE_LIMITED = `${BASE_URL}/sign-in?error=RateLimited`
  const callbackPath = (email: string, token: string) =>
    `/api/auth/callback/email?${new URLSearchParams({ email, token, callbackUrl: "/app" })}`

  it("emails the link's token as a code that signs in where it is typed", async () => {
    // The phone's installed app asks for the link...
    const app = new Browser("2001:db8::d:1")
    await app.requestMagicLink("phone@example.test")
    const email = sent.at(-1)
    expect(email?.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(new URL(email?.url ?? "").searchParams.get("token")).toBe(email?.code)

    // ...and the person types the code there, in lower case with a dash, the email as they gave
    // it. (Tapping the link in Mail would sign Safari in instead.)
    const code = email?.code ?? ""
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase()
    const response = await app.request("GET", callbackPath("Phone@Example.test", typed))
    expect(response.headers.get("location")).toBe(`${BASE_URL}/app`)
    expect((await app.sessionUser())?.email).toBe("phone@example.test")

    // Once only, like the link.
    const again = await new Browser("2001:db8::d:2").request(
      "GET",
      callbackPath("phone@example.test", code),
    )
    expect(again.headers.get("location")).toBe(`${BASE_URL}/sign-in?error=Verification`)
  })

  it("only matches the email it was sent to", async () => {
    const browser = new Browser("2001:db8::d:3")
    await browser.requestMagicLink("owner@example.test")
    const code = sent.at(-1)?.code ?? ""
    const response = await new Browser("2001:db8::d:4").request(
      "GET",
      callbackPath("someone-else@example.test", code),
    )
    expect(response.headers.get("location")).toBe(`${BASE_URL}/sign-in?error=Verification`)
    // The right person can still use it.
    const owner = await browser.request("GET", callbackPath("owner@example.test", code))
    expect(owner.headers.get("location")).toBe(`${BASE_URL}/app`)
  })

  it("limits guesses per email, from any number of IPs, and per IP", async () => {
    const { limit } = EMAIL_CALLBACK_RATE_LIMIT
    await new Browser("2001:db8::e:1").requestMagicLink("guess@example.test")
    const real = sent.at(-1)?.code ?? ""
    for (let i = 1; i <= limit; i++) {
      const wrong = await new Browser(`2001:db8::e:${i + 1}`).request(
        "GET",
        callbackPath("guess@example.test", "ZZZZZZZZ"),
      )
      expect(wrong.headers.get("location")).toBe(`${BASE_URL}/sign-in?error=Verification`)
    }
    // Even the right code is refused now, without reaching Auth.js (the token is not used up).
    const blocked = await new Browser("2001:db8::e:ff").request(
      "GET",
      callbackPath("guess@example.test", real),
    )
    expect(blocked.status).toBe(303)
    expect(blocked.headers.get("location")).toBe(RATE_LIMITED)
    expect(
      await testDb.db
        .select()
        .from(verificationTokens)
        .where(eq(verificationTokens.identifier, "guess@example.test")),
    ).toHaveLength(1)

    const browser = new Browser("2001:db8::e:100")
    for (let i = 1; i <= limit; i++) {
      await browser.request("GET", callbackPath(`ip-guess-${i}@example.test`, "ZZZZZZZZ"))
    }
    const ipBlocked = await browser.request("GET", callbackPath("fresh@example.test", "ZZZZZZZZ"))
    expect(ipBlocked.headers.get("location")).toBe(RATE_LIMITED)
  })
})

describe("OAuth login (§14: state + PKCE)", () => {
  const oauthEnv = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/unused",
    AUTH_SECRET: "integration-test-auth-secret-0123456789",
    ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
    STRIPE_WEBHOOK_SECRET: "whsec_integration",
    AUTH_GOOGLE_ID: "google-client-id",
    AUTH_GOOGLE_SECRET: "google-client-secret",
    AUTH_GITHUB_ID: "github-client-id",
    AUTH_GITHUB_SECRET: "github-client-secret",
  })
  const oauth = NextAuth((request) => createAuthConfig(request, { db: testDb.db, env: oauthEnv }))
  const oauthHandlers: AuthHandlers = oauth.handlers

  /** Google is an OpenID provider: Auth.js reads its endpoints from the discovery document. */
  function stubGoogleDiscovery() {
    const issuer = "https://accounts.google.com"
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== `${issuer}/.well-known/openid-configuration`) {
        throw new Error(`Unexpected request to ${url}`)
      }
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/o/oauth2/v2/auth`,
        token_endpoint: "https://oauth2.googleapis.com/token",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
        code_challenge_methods_supported: ["plain", "S256"],
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      })
    })
  }

  it.each([
    ["github", "https://github.com/login/oauth/authorize"],
    ["google", "https://accounts.google.com/o/oauth2/v2/auth"],
  ])("sends %s a state and a PKCE challenge, and keeps both in cookies", async (id, endpoint) => {
    if (id === "google") stubGoogleDiscovery()
    const browser = new Browser("2001:db8::d:1", oauthHandlers)
    const location = new URL(await browser.startSignIn(id))

    expect(`${location.origin}${location.pathname}`).toBe(endpoint)
    expect(location.searchParams.get("state")).toEqual(expect.any(String))
    expect(location.searchParams.get("code_challenge")).toEqual(expect.any(String))
    expect(location.searchParams.get("code_challenge_method")).toBe("S256")
    expect(browser.cookies.has("authjs.state")).toBe(true)
    expect(browser.cookies.has("authjs.pkce.code_verifier")).toBe(true)
  })
})

describe("the /api/auth route", () => {
  it("closes Auth.js's HTTP sign-in endpoint: sign-in starts from our server actions", async () => {
    for (const path of ["/api/auth/signin/email", "/api/auth/signin/github", "/api/auth/signin"]) {
      const response = await authRoutePOST(
        new NextRequest(new URL(path, BASE_URL), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ email: "direct@example.test", csrfToken: "x" }).toString(),
        }),
      )
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("GET")
    }
    expect(sent).toEqual([])
  })
})
