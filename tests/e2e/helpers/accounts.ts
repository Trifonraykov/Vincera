import { randomBytes } from "node:crypto"

/**
 * E2E accounts. The web server runs with ADMIN_EMAILS=E2E_ADMIN_EMAIL (playwright.config.ts),
 * so that address gets the admin role when it signs up.
 */
export const E2E_ADMIN_EMAIL = "e2e-admin@example.com"

/** A fresh address per call, so retries and repeated runs never collide. */
export function uniqueEmail(label: string): string {
  return `e2e-${label}-${randomBytes(4).toString("hex")}@example.com`
}
