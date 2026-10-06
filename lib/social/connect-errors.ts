import { SOCIAL_PROVIDER_META } from "./catalog"
import { isSocialErrorCode, socialErrorMessage, SOCIAL_ERROR_CODES } from "./errors"
import type { SocialProviderId } from "./types"

/**
 * The `?error=<code>` values the OAuth connection routes (`/api/oauth/[provider]/start` and
 * `/callback`) send back to the page that started the flow, and their plain-language messages
 * (§4). Client-safe. Codes never carry provider text.
 *
 * Provider failures use `socialErrorCode()` (lib/social/errors.ts); the rest are the flow's own.
 */
export const CONNECT_FLOW_ERROR_CODES = [
  /** The user pressed Cancel / Deny on the provider's consent screen. */
  "access_denied",
  /** The state cookie was missing, tampered with, or issued to someone else. */
  "state_invalid",
  /** More than 10 minutes passed between starting and finishing. */
  "session_expired",
  /** The provider account is already connected to another user of the platform. */
  "account_in_use",
  /** The user's roles do not allow this provider (e.g. a builder connecting YouTube). */
  "not_allowed",
  /** The provider's OAuth is switched off (SOCIAL_OAUTH_DISABLED, e.g. app review pending). */
  "oauth_disabled",
] as const
export type ConnectFlowErrorCode = (typeof CONNECT_FLOW_ERROR_CODES)[number]

export const CONNECT_ERROR_CODES = [...SOCIAL_ERROR_CODES, ...CONNECT_FLOW_ERROR_CODES] as const
export type ConnectErrorCode = (typeof CONNECT_ERROR_CODES)[number]

export function isConnectErrorCode(value: string): value is ConnectErrorCode {
  return (CONNECT_ERROR_CODES as readonly string[]).includes(value)
}

/** The message for a connect error; unknown codes get a generic one. */
export function connectErrorMessage(code: string, provider: SocialProviderId | null): string {
  const label = provider ? SOCIAL_PROVIDER_META[provider].label : "the provider"
  switch (code) {
    case "access_denied":
      return `You cancelled the ${label} connection, so nothing was connected. You can try again any time.`
    case "state_invalid":
      return `We couldn't confirm that this ${label} connection was started by you. Please start it again from this page.`
    case "session_expired":
      return `The ${label} connection took too long and timed out. Please try again.`
    case "account_in_use":
      return `That ${label} account is already connected to a different account on our platform. Sign in with that account instead, or connect another ${label} account.`
    case "not_allowed":
      return `${label} isn't available for your role. Creators connect YouTube, Instagram or TikTok; builders connect GitHub.`
    case "oauth_disabled":
      return provider === "github" || provider === null
        ? `Connecting ${label} isn't available right now. Please try again later.`
        : `Connecting ${label} isn't available yet. Enter your numbers by hand for now; you can connect later.`
    default:
      return isSocialErrorCode(code)
        ? socialErrorMessage(code, label)
        : `Something went wrong while connecting ${label}. Please try again.`
  }
}

/**
 * Append `?connected=<provider>` or `?error=<code>&provider=<provider>` to an in-app path
 * (dropping earlier values of those parameters). The path must already be safe (relative,
 * same-origin; see `safeCallbackUrl`).
 */
export function withConnectResult(
  path: string,
  result: { connected: SocialProviderId } | { error: ConnectErrorCode; provider: SocialProviderId },
): string {
  const url = new URL(path, "http://app.invalid")
  for (const key of ["connected", "error", "provider"]) url.searchParams.delete(key)
  if ("connected" in result) {
    url.searchParams.set("connected", result.connected)
  } else {
    url.searchParams.set("error", result.error)
    url.searchParams.set("provider", result.provider)
  }
  return `${url.pathname}${url.search}${url.hash}`
}
