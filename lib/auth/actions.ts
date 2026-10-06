"use server"

import { AuthError } from "next-auth"
import { cookies, headers } from "next/headers"
import { redirect, unstable_rethrow } from "next/navigation"
import { z } from "zod"

import { isProduction } from "@/lib/env"
import { reportError } from "@/lib/observability"

import { signIn, signOut } from "./auth"
import { configuredOAuthProviders, EMAIL_PROVIDER_ID, OAUTH_PROVIDER_IDS } from "./config"
import { IMPERSONATION_COOKIE } from "./impersonation-cookie"
import type { MagicLinkState } from "./magic-link-state"
import { isAuthRateLimited } from "./rate-limit"
import {
  displayNameSchema,
  PENDING_NAME_COOKIE,
  PENDING_NAME_COOKIE_PATH,
  PENDING_NAME_MAX_AGE_SECONDS,
} from "./pending-name"
import {
  AUTH_ROUTES,
  safeCallbackUrl,
  SIGN_IN_ERROR_MESSAGES,
  signInErrorMessage,
  signInUrl,
} from "./routes"

/**
 * Auth server actions used by /sign-in, /sign-up and the app shell. Signing in goes through
 * Auth.js's server-side `signIn()`, so Auth.js still owns tokens, the signIn callback and
 * sessions; these actions add validation and plain-language errors. The §14 rate limit for magic
 * links lives in the signIn callback (lib/auth/config.ts), which every magic-link request passes;
 * OAuth sign-in has no such hook before the redirect, so `signInWithProvider` limits it here.
 */

/** Missing (`formData.get` → null) and blank form fields both count as "not given". */
const emptyToUndefined = (value: unknown) =>
  value === null || (typeof value === "string" && value.trim() === "") ? undefined : value

const magicLinkSchema = z.object({
  intent: z.enum(["sign-in", "sign-up"]),
  email: z
    .string({ error: "Enter your email address." })
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email address, like name@example.com.").max(254)),
  name: z.preprocess(emptyToUndefined, displayNameSchema.optional()),
  callbackUrl: z.preprocess(emptyToUndefined, z.string().max(2048).optional()),
})

function fieldValue(formData: FormData, key: string): string {
  const value = formData.get(key)
  return typeof value === "string" ? value : ""
}

/** Auth.js reports some failures as a redirect to the error page (`?error=…`). */
function errorCodeFrom(redirectUrl: unknown): string | null {
  if (typeof redirectUrl !== "string") return null
  try {
    return new URL(redirectUrl, "http://placeholder.invalid").searchParams.get("error")
  } catch {
    return null
  }
}

/**
 * Send a magic link (sign-in and sign-up). For `useActionState`. The response is the same
 * whether or not the email has an account, so the form does not reveal who is registered.
 */
export async function requestMagicLink(
  _previous: MagicLinkState,
  formData: FormData,
): Promise<MagicLinkState> {
  const values = { email: fieldValue(formData, "email"), name: fieldValue(formData, "name") }
  const parsed = magicLinkSchema.safeParse({
    intent: formData.get("intent"),
    email: values.email,
    name: values.name,
    callbackUrl: formData.get("callbackUrl"),
  })
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error)
    return {
      status: "error",
      message: "Please check the highlighted fields.",
      fieldErrors: { email: fieldErrors.email, name: fieldErrors.name },
      values,
    }
  }
  const { email, name, intent } = parsed.data

  try {
    const redirectUrl: unknown = await signIn(EMAIL_PROVIDER_ID, {
      email,
      redirectTo: safeCallbackUrl(parsed.data.callbackUrl),
      redirect: false,
    })
    // Refusals from the signIn callback (`RateLimited`, `AccessDenied`…) arrive as `?error=`.
    const errorCode = errorCodeFrom(redirectUrl)
    if (errorCode) {
      // Failing to send the email surfaces as a generic "Configuration" error.
      const message =
        errorCode === "Configuration"
          ? SIGN_IN_ERROR_MESSAGES.EmailSignInError
          : signInErrorMessage(errorCode)
      return { status: "error", message: message ?? SIGN_IN_ERROR_MESSAGES.Default, values }
    }
  } catch (error) {
    unstable_rethrow(error)
    if (error instanceof AuthError && error.type === "AccessDenied") {
      return { status: "error", message: SIGN_IN_ERROR_MESSAGES.AccessDenied, values }
    }
    reportError(error, { tags: { action: "auth.request_magic_link" } })
    return { status: "error", message: SIGN_IN_ERROR_MESSAGES.EmailSignInError, values }
  }

  if (intent === "sign-up" && name) {
    ;(await cookies()).set(PENDING_NAME_COOKIE, name, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction(),
      path: PENDING_NAME_COOKIE_PATH,
      maxAge: PENDING_NAME_MAX_AGE_SECONDS,
    })
  }
  return { status: "sent", email }
}

const oauthSchema = z.object({
  provider: z.enum(OAUTH_PROVIDER_IDS),
  callbackUrl: z.preprocess(emptyToUndefined, z.string().max(2048).optional()),
})

/** Start Google/GitHub sign-in (a `<form action>`); redirects to the provider. */
export async function signInWithProvider(formData: FormData): Promise<void> {
  const parsed = oauthSchema.safeParse({
    provider: formData.get("provider"),
    callbackUrl: formData.get("callbackUrl"),
  })
  if (!parsed.success || !configuredOAuthProviders().includes(parsed.data.provider)) {
    redirect(signInUrl({ error: "Default" }))
  }
  if (await isAuthRateLimited(await headers())) {
    redirect(signInUrl({ error: "RateLimited" }))
  }
  // Throws Next.js's redirect to the provider's consent page.
  await signIn(parsed.data.provider, { redirectTo: safeCallbackUrl(parsed.data.callbackUrl) })
}

/**
 * Sign out (the shell's user menu): deletes the database session and clears the cookie, and an
 * admin's "view as" cookie with it (CLAUDE.md §19.38; the open session row then simply expires).
 */
export async function signOutAction(): Promise<void> {
  ;(await cookies()).delete(IMPERSONATION_COOKIE)
  await signOut({ redirectTo: AUTH_ROUTES.afterSignOut })
}
