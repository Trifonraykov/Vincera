import { SocialTokenError, type SocialProviderId } from "./types"

/**
 * Errors the social providers throw (§7.1). Client-safe: no server-only imports.
 *
 * - `SocialTokenError` (lib/social/types.ts): the token is expired or revoked. The sync marks the
 *   connection `expired` and asks the user to reconnect.
 * - `SocialRetryableError`: rate limits (429, quota errors), provider outages (5xx), network
 *   failures and timeouts. Jobs retry these; nothing about the connection changes.
 * - `SocialProviderError`: everything else, with a short `code` the UI can explain.
 *
 * Messages name the provider, the endpoint and the HTTP status only: never a token, a URL with
 * its query string, or a response body (§4, §14).
 */

export { SocialTokenError }

/** Why a provider call failed for good (not a token problem, not worth an immediate retry). */
export const SOCIAL_FAILURE_CODES = [
  /** The provider answered with a shape we do not understand. */
  "invalid_response",
  /** The authorization code was rejected (expired, already used, wrong redirect URI). */
  "invalid_code",
  /** The Google account has no YouTube channel. */
  "no_channel",
  /** The user unticked a scope we cannot work without. */
  "scope_missing",
  /** The account type cannot be connected (e.g. a personal Instagram account). */
  "not_eligible",
  /** Any other refusal (4xx), including our own configuration errors. */
  "provider_error",
] as const
export type SocialFailureCode = (typeof SOCIAL_FAILURE_CODES)[number]

export class SocialProviderError extends Error {
  constructor(
    readonly provider: SocialProviderId,
    readonly code: SocialFailureCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message)
    this.name = "SocialProviderError"
  }
}

export class SocialRetryableError extends Error {
  constructor(
    readonly provider: SocialProviderId,
    readonly reason: "rate_limited" | "unavailable",
    message: string,
    readonly options: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message)
    this.name = "SocialRetryableError"
  }

  get status(): number | null {
    return this.options.status ?? null
  }

  get retryAfterSeconds(): number | null {
    return this.options.retryAfterSeconds ?? null
  }
}

/**
 * Short error codes for `social_connections.last_sync_error` and the OAuth callback's
 * `?error=` parameter (CLAUDE.md §19.11). Never contain provider text.
 */
export const SOCIAL_ERROR_CODES = [
  "token_expired",
  "rate_limited",
  "provider_unavailable",
  ...SOCIAL_FAILURE_CODES,
] as const
export type SocialErrorCode = (typeof SOCIAL_ERROR_CODES)[number]

export function socialErrorCode(error: unknown): SocialErrorCode {
  if (error instanceof SocialTokenError) return "token_expired"
  if (error instanceof SocialRetryableError) {
    return error.reason === "rate_limited" ? "rate_limited" : "provider_unavailable"
  }
  if (error instanceof SocialProviderError) return error.code
  return "provider_error"
}

/** Plain-language explanations (§4) for each code; `provider` is the display label. */
export function socialErrorMessage(code: SocialErrorCode, provider: string): string {
  switch (code) {
    case "token_expired":
      return `Your ${provider} connection has expired. Reconnect ${provider} to keep your stats up to date.`
    case "rate_limited":
      return `${provider} asked us to slow down. We'll try again shortly; there's nothing you need to do.`
    case "provider_unavailable":
      return `We couldn't reach ${provider} just now. Please try again in a few minutes.`
    case "invalid_response":
      return `${provider} sent us data we couldn't read. We've been notified; please try again later.`
    case "invalid_code":
      return `The ${provider} sign-in didn't complete or took too long. Please try connecting again.`
    case "no_channel":
      return `That Google account doesn't have a YouTube channel. Connect the account that owns your channel.`
    case "scope_missing":
      return `We need the permissions ${provider} asked you about to read your audience stats. Please connect again and allow them all.`
    case "not_eligible":
      return `This ${provider} account type can't be connected. Switch to a professional (Business or Creator) account and try again.`
    case "provider_error":
      return `Something went wrong while talking to ${provider}. Please try again.`
  }
}

export function isSocialErrorCode(value: string): value is SocialErrorCode {
  return (SOCIAL_ERROR_CODES as readonly string[]).includes(value)
}
