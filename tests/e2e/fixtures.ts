import { randomBytes } from "node:crypto"
import { test as base } from "@playwright/test"

export { expect } from "@playwright/test"

/**
 * The e2e `test`: every test is a different visitor with its own client IP.
 *
 * The app keys per-IP rate limits (§14, lib/ratelimit.ts) on `x-forwarded-for`, which Vercel sets
 * and Next.js otherwise fills with the socket address. Without this, every test (and, with a
 * reused dev server, every run) would share localhost's budget, e.g. 10 magic-link requests per
 * 10 minutes. Addresses come from the IPv6 documentation range (RFC 3849).
 */
export const test = base.extend({
  // The fixture callback is named `provide`, not Playwright's usual `use`, so the React hooks lint
  // rule does not mistake it for React's `use()`.
  extraHTTPHeaders: async ({ extraHTTPHeaders }, provide) => {
    const [a, b] = [randomBytes(2).toString("hex"), randomBytes(2).toString("hex")]
    await provide({ ...extraHTTPHeaders, "x-forwarded-for": `2001:db8::${a}:${b}` })
  },
})
