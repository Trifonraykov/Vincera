import { safeCallbackUrl, signInErrorMessage } from "@/lib/auth/routes"

export type AuthSearchParams = Promise<Record<string, string | string[] | undefined>>

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** The query parameters the auth pages understand, validated. */
export async function readAuthParams(searchParams: AuthSearchParams) {
  const params = await searchParams
  const rawCallback = first(params.callbackUrl)
  return {
    /** Same-origin path to return to, or undefined (then sign-in lands on /app). */
    callbackUrl: rawCallback ? safeCallbackUrl(rawCallback, "") || undefined : undefined,
    error: signInErrorMessage(first(params.error)),
    /** Auth.js's verify-request redirect (`?provider=email&type=email`). */
    checkEmail: first(params.type) === "email",
  }
}

/** Link to the other auth page, keeping the callbackUrl. */
export function withCallback(path: string, callbackUrl: string | undefined): string {
  return callbackUrl ? `${path}?${new URLSearchParams({ callbackUrl })}` : path
}
