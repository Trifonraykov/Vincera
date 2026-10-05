import "server-only"

import { AuthError, type NextAuthConfig } from "next-auth"
import type { EmailConfig } from "next-auth/providers/email"
import GitHub from "next-auth/providers/github"
import Google from "next-auth/providers/google"
import type { NextRequest } from "next/server"

import { getDb, type Db } from "@/lib/db/client"
import { getEnv, type Env } from "@/lib/env"
import type { AuthMethod } from "@/lib/events/types"
import { reportError } from "@/lib/observability"

import { createAuthAdapter } from "./adapter"
import { parsePendingName, PENDING_NAME_COOKIE } from "./pending-name"
import { AUTH_ROUTES, signInUrl } from "./routes"
import { isSuspendedSignIn } from "./suspension"
import { parseAuthUser, toSessionUser } from "./user"

/**
 * Auth.js v5 configuration (§6).
 *
 * - Providers: email magic link (always; sent through lib/email, so the fake outbox receives it),
 *   Google and GitHub (only when their AUTH_* credentials are set).
 * - Database sessions: the session cookie holds an opaque token, `sessions` maps it to a user id,
 *   and the lookup joins `users`, so roles, active role and status are read fresh on every request
 *   and suspending a user or deleting their sessions takes effect immediately. Next 16's proxy
 *   runs on Node.js, so the proxy can use the database adapter too.
 * - The config is built per request (`NextAuth(request => …)`): the sign-up method and the
 *   pending /sign-up name come from the callback request.
 * - Rate limiting (§14): every magic-link request reaches the `signIn` callback with
 *   `email.verificationRequest`, whether it comes from our server action or from a direct POST to
 *   Auth.js's endpoint, so the `auth` limit (per IP and per email) is enforced there.
 * - OAuth login uses both a `state` parameter and PKCE (§14).
 */

export const EMAIL_PROVIDER_ID = "email"
export const OAUTH_PROVIDER_IDS = ["google", "github"] as const
export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number]

const MAGIC_LINK_MAX_AGE_SECONDS = 24 * 60 * 60
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/** Auth.js errors caused by users (expired links, wrong method…), not by our code. */
const EXPECTED_AUTH_ERRORS = new Set([
  "AccessDenied",
  "Verification",
  "OAuthAccountNotLinked",
  "AccountNotLinked",
  "MissingCSRF",
])

/** The OAuth login providers whose credentials are configured, in display order. */
export function configuredOAuthProviders(e: Env = getEnv()): OAuthProviderId[] {
  return OAUTH_PROVIDER_IDS.filter((id) =>
    id === "google"
      ? Boolean(e.AUTH_GOOGLE_ID && e.AUTH_GOOGLE_SECRET)
      : Boolean(e.AUTH_GITHUB_ID && e.AUTH_GITHUB_SECRET),
  )
}

function emailProvider(): EmailConfig {
  return {
    id: EMAIL_PROVIDER_ID,
    type: "email",
    name: "Email",
    maxAge: MAGIC_LINK_MAX_AGE_SECONDS,
    async sendVerificationRequest({ identifier, url }) {
      // Loaded on demand: the proxy imports this config on every request but never sends email.
      const { sendMagicLinkEmail } = await import("@/lib/email/magic-link")
      await sendMagicLinkEmail({
        to: identifier,
        url,
        expiresInMinutes: MAGIC_LINK_MAX_AGE_SECONDS / 60,
      })
    },
  }
}

/**
 * §14: `state` plus PKCE on every OAuth flow. Auth.js defaults to PKCE only (it adds `state` just
 * for its redirect proxy), so both checks are listed explicitly. The array is created per call:
 * Auth.js may modify a provider's `checks` in place.
 */
export const OAUTH_CHECKS = ["pkce", "state"] as const

function oauthProviders(e: Env) {
  return configuredOAuthProviders(e).map((id) => {
    const options = { checks: [...OAUTH_CHECKS] }
    return id === "google"
      ? Google({ ...options, clientId: e.AUTH_GOOGLE_ID, clientSecret: e.AUTH_GOOGLE_SECRET })
      : GitHub({ ...options, clientId: e.AUTH_GITHUB_ID, clientSecret: e.AUTH_GITHUB_SECRET })
  })
}

/**
 * Headers of the request being handled. The route handler passes its request to the config;
 * server actions run Auth.js in-process without one (`config(undefined)`), but inside the
 * action's own request scope, where Next's `headers()` has the same client headers.
 */
async function requestHeaders(request: NextRequest | undefined): Promise<Headers> {
  if (request) return request.headers
  const { headers } = await import("next/headers")
  return headers()
}

/** Sign-ups happen on `/api/auth/callback/<provider>`; the provider id is the sign-up method. */
export function signUpMethodFrom(pathname: string | undefined): AuthMethod {
  const provider = pathname?.match(/\/callback\/([^/?#]+)$/)?.[1]
  return provider === "google" || provider === "github" ? provider : "email"
}

/** Injectable for tests; the app uses the process environment and the app database. */
export type AuthConfigDeps = { db?: Db; env?: Env }

export function createAuthConfig(request?: NextRequest, deps: AuthConfigDeps = {}): NextAuthConfig {
  const e = deps.env ?? getEnv()
  const db = deps.db ?? getDb()

  return {
    secret: e.AUTH_SECRET,
    adapter: createAuthAdapter(db, {
      method: signUpMethodFrom(request?.nextUrl.pathname),
      adminEmails: e.ADMIN_EMAILS,
      pendingName: parsePendingName(request?.cookies.get(PENDING_NAME_COOKIE)?.value),
    }),
    session: { strategy: "database", maxAge: SESSION_MAX_AGE_SECONDS },
    providers: [emailProvider(), ...oauthProviders(e)],
    pages: {
      signIn: AUTH_ROUTES.signIn,
      // Errors and "check your email" render as states of the sign-in page.
      error: AUTH_ROUTES.signIn,
      verifyRequest: AUTH_ROUTES.signIn,
    },
    callbacks: {
      async signIn({ user, email }) {
        if (!user.email) return signInUrl({ error: "EmailRequired" })
        // A magic-link request (not the click on the link). Checked before the suspension lookup,
        // so nobody can probe addresses at scale either.
        if (email?.verificationRequest) {
          // Loaded on demand, like the email sender: the proxy builds this config on every request.
          const { isAuthRateLimited } = await import("./rate-limit")
          if (await isAuthRateLimited(await requestHeaders(request), user.email)) {
            return signInUrl({ error: "RateLimited" })
          }
        }
        return !(await isSuspendedSignIn(db, user))
      },
      session({ session, user }) {
        // Database strategy: `user` is the `users` row joined to the session.
        const authUser = parseAuthUser(user)
        if (!authUser) throw new Error("Session user failed validation")
        return { expires: new Date(session.expires).toISOString(), user: toSessionUser(authUser) }
      },
    },
    logger: {
      error(error) {
        if (error instanceof AuthError && EXPECTED_AUTH_ERRORS.has(error.type)) return
        reportError(error, { tags: { area: "auth" } })
      },
    },
  }
}
