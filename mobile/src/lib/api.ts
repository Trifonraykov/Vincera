import { apiErrorSchema, MOBILE_API_PREFIX } from "@shared/schemas"
import type { z } from "zod"

import { getApiUrl } from "./config"

/**
 * The mobile API client. Every response is parsed with the same Zod schema the server validated
 * it against (lib/mobile-api/schemas.ts), so a contract change shows up as a clear error instead
 * of a crash deep in a screen.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message)
    this.name = "ApiError"
  }

  /** The first message for a form field, if the server sent one. */
  field(name: string): string | undefined {
    return this.fieldErrors[name]?.[0]
  }
}

let currentToken: string | null = null
let onUnauthorized: (() => void) | null = null

export function setApiToken(token: string | null): void {
  currentToken = token
}

/** Called when the server says the session ended (401), so the app returns to sign-in. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export async function api<S extends z.ZodType>(
  schema: S,
  method: Method,
  path: string,
  body?: unknown,
): Promise<z.output<S>> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`
  if (body !== undefined) headers["Content-Type"] = "application/json"

  let response: Response
  try {
    response = await fetch(`${getApiUrl()}${MOBILE_API_PREFIX}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, "network", "Can't reach Vincera. Check your connection and try again.")
  }

  const json: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(json)
    const error = parsed.success
      ? new ApiError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.fieldErrors ?? {},
        )
      : new ApiError(response.status, "internal", "Something went wrong. Please try again.")
    if (response.status === 401 && currentToken) onUnauthorized?.()
    throw error
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      "contract",
      "This version of the app doesn't understand the server's answer. Update the app.",
    )
  }
  return parsed.data
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again."
}
