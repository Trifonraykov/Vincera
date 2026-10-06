/**
 * Auth routes and redirect helpers. Client-safe and pure (used by the proxy, pages and tests).
 */

export const AUTH_ROUTES = {
  signIn: "/sign-in",
  signUp: "/sign-up",
  /** Where a successful sign-in lands when there is no (valid) callbackUrl. */
  afterSignIn: "/app",
  afterSignOut: "/",
} as const

/**
 * Request header the proxy sets to the requested path + query, so server components can build a
 * callbackUrl (`requireUser()`); server components cannot read the URL otherwise.
 */
export const PATHNAME_HEADER = "x-pathname"

/**
 * Error codes shown on the sign-in page (`/sign-in?error=…`): Auth.js's client-safe error types
 * plus our own. Unknown codes fall back to a generic message.
 */
export const SIGN_IN_ERROR_MESSAGES = {
  Verification:
    "That sign-in link or code is invalid or has expired. Each works once and expires after 24 hours. Request a new one below.",
  AccessDenied: "This account can't sign in. If you think this is a mistake, contact support.",
  AccountSuspended:
    "Your account is suspended, so you can't use the app right now. If you think this is a mistake, contact support.",
  OAuthAccountNotLinked:
    "This email address is already registered with a different sign-in method. Sign in the way you did before, for example with an email link.",
  AccountNotLinked:
    "This email address is already registered with a different sign-in method. Sign in the way you did before, for example with an email link.",
  OAuthCallbackError: "Signing in with that provider didn't complete. Please try again.",
  EmailRequired:
    "That account didn't share an email address with us. Make your email visible to the provider, or sign in with an email link instead.",
  EmailSignInError: "We couldn't send your sign-in link. Please try again in a moment.",
  RateLimited: "Too many sign-in attempts. Please wait a few minutes and try again.",
  Default: "Something went wrong while signing you in. Please try again.",
} as const

export type SignInErrorCode = keyof typeof SIGN_IN_ERROR_MESSAGES

export function signInErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null
  return Object.hasOwn(SIGN_IN_ERROR_MESSAGES, code)
    ? SIGN_IN_ERROR_MESSAGES[code as SignInErrorCode]
    : SIGN_IN_ERROR_MESSAGES.Default
}

/** Paths a callbackUrl must never point at: they would loop back into the auth flow. */
const DISALLOWED_CALLBACK_PREFIXES = [AUTH_ROUTES.signIn, AUTH_ROUTES.signUp, "/api/"] as const

const PLACEHOLDER_ORIGIN = "http://callback.invalid"

/**
 * A same-origin path to return to after signing in, or `fallback`.
 * Accepts only relative paths ("/app/ideas?x=1"); absolute URLs, protocol-relative URLs
 * ("//evil.example"), backslash tricks and auth pages are rejected (open-redirect safe).
 */
export function safeCallbackUrl(
  value: string | null | undefined,
  fallback: string = AUTH_ROUTES.afterSignIn,
): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback
  }
  // Control characters and backslashes are never part of a legitimate in-app path.
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback

  let url: URL
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN)
  } catch {
    return fallback
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return fallback

  const path = url.pathname
  // Dot segments collapse during parsing ("/.//evil.example", "/x/..//evil.example" become
  // "//evil.example"), so the normalised path needs the protocol-relative check again.
  if (path.startsWith("//")) return fallback
  const blocked = DISALLOWED_CALLBACK_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
  )
  return blocked ? fallback : `${path}${url.search}${url.hash}`
}

/**
 * Absolute URL for an in-app redirect target, resolved against the current request URL.
 * Anything that would leave `base`'s origin becomes `AUTH_ROUTES.afterSignIn` instead
 * (defence in depth behind `safeCallbackUrl`, for the proxy's redirects).
 */
export function sameOriginRedirectUrl(to: string, base: string | URL): URL {
  const baseUrl = new URL(base)
  let target: URL | undefined
  try {
    target = new URL(to, baseUrl)
  } catch {
    target = undefined
  }
  return target && target.origin === baseUrl.origin
    ? target
    : new URL(AUTH_ROUTES.afterSignIn, baseUrl)
}

/** `/sign-in`, optionally with a callbackUrl to return to and an error code to show. */
export function signInUrl(options: { callbackUrl?: string; error?: SignInErrorCode } = {}): string {
  const params = new URLSearchParams()
  if (options.callbackUrl) {
    const callbackUrl = safeCallbackUrl(options.callbackUrl, "")
    if (callbackUrl) params.set("callbackUrl", callbackUrl)
  }
  if (options.error) params.set("error", options.error)
  const query = params.toString()
  return query ? `${AUTH_ROUTES.signIn}?${query}` : AUTH_ROUTES.signIn
}
