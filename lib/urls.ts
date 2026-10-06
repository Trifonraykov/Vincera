import "server-only"

import { env } from "@/lib/env"

/**
 * Absolute URL of an app path, for links that leave the browser: emails, OAuth `redirect_uri`,
 * Stripe `return_url` / `refresh_url`. Only same-origin paths are accepted.
 */
export function absoluteUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`absoluteUrl expects an app path starting with "/", got "${path}"`)
  }
  return new URL(path, env.NEXT_PUBLIC_APP_URL).toString()
}
