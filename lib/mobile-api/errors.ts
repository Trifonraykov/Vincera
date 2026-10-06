import "server-only"

import type { ApiErrorCode } from "./schemas"

/**
 * A refusal the mobile API answers with a status and a plain-language message (CLAUDE.md §19.44).
 * Business refusals from the shared services arrive as `ActionError` and are mapped by the router
 * (422 `refused`); this class is for what the API layer itself decides (auth, 404s, limits).
 */
export class MobileApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = "MobileApiError"
  }
}

export const MOBILE_MESSAGES = {
  unauthorized: "Your session has ended. Sign in again.",
  suspended: "This account is suspended. Contact support if you think this is a mistake.",
  onboarding: "Finish setting up your account on the web first.",
  notFound: "We couldn't find that. It may have been removed, or you don't have access.",
  forbidden: "You don't have permission to do that.",
  invalidInput: "Please check the highlighted fields.",
  rateLimited: "Too many attempts in a short time. Wait a few minutes and try again.",
  unexpected: "Something went wrong on our side. Please try again.",
  badCode: "That code is wrong or has expired. Ask for a new one.",
  emailFailed: "We couldn't send the email right now. Please try again in a moment.",
} as const

export const notFound = () => new MobileApiError(404, "not_found", MOBILE_MESSAGES.notFound)
export const forbidden = () => new MobileApiError(403, "forbidden", MOBILE_MESSAGES.forbidden)
