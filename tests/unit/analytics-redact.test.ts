import { describe, expect, it } from "vitest"

import { redactPostHogEvent } from "@/lib/analytics/posthog-client"
import { redactDeep, redactSensitiveText } from "@/lib/analytics/redact"

import { scrubEvent, withoutQuery } from "../../sentry.shared"

/** Buyer access tokens and Checkout session ids never reach PostHog or Sentry (CLAUDE.md §19.37). */

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"
const ACCESS_URL = `https://app.example.com/access/${TOKEN}/files/0192e4c1-1111-7000-8000-000000000000`
const SUCCESS_URL = "https://app.example.com/p/meal-planner/success?session_id=cs_live_a1B2c3&x=1"

describe("redactSensitiveText", () => {
  it("replaces access tokens and credential query values", () => {
    expect(redactSensitiveText(ACCESS_URL)).toBe(
      "https://app.example.com/access/[token]/files/0192e4c1-1111-7000-8000-000000000000",
    )
    expect(redactSensitiveText(SUCCESS_URL)).toBe(
      "https://app.example.com/p/meal-planner/success?session_id=[redacted]&x=1",
    )
    expect(
      redactSensitiveText(
        "/api/auth/callback/email?token=ABCD1234&email=a%40b.c&callbackUrl=%2Fapp",
      ),
    ).toBe("/api/auth/callback/email?token=[redacted]&email=[redacted]&callbackUrl=%2Fapp")
    expect(redactSensitiveText("/p/meal-planner?ref=Ab12Cd34")).toBe("/p/meal-planner?ref=Ab12Cd34")
    // Route patterns and short words are not tokens.
    expect(redactSensitiveText("app/access/[token]/page.tsx")).toBe("app/access/[token]/page.tsx")
  })

  it("walks nested values", () => {
    const value = { a: [ACCESS_URL, { b: SUCCESS_URL }], n: 3 }
    redactDeep(value)
    expect(JSON.stringify(value)).not.toContain(TOKEN)
    expect(JSON.stringify(value)).not.toContain("cs_live_a1B2c3")
  })
})

describe("PostHog before_send", () => {
  it("scrubs page views and autocapture element chains", () => {
    const event = redactPostHogEvent({
      uuid: "u",
      event: "$autocapture",
      properties: {
        $current_url: ACCESS_URL,
        $pathname: `/access/${TOKEN}`,
        $referrer: SUCCESS_URL,
        $initial_current_url: SUCCESS_URL,
        $elements_chain: `a:text="Open your purchase"attr__href="/access/${TOKEN}"nth-child="1"`,
      },
      $set_once: { $initial_current_url: ACCESS_URL },
    })
    const serialised = JSON.stringify(event)
    expect(serialised).not.toContain(TOKEN)
    expect(serialised).not.toContain("cs_live_a1B2c3")
    expect(event?.properties.$pathname).toBe("/access/[token]")
    expect(redactPostHogEvent(null)).toBeNull()
  })
})

describe("Sentry", () => {
  it("never sends an access token, in the path or anywhere in the event", () => {
    expect(withoutQuery(`/access/${TOKEN}/files/x?y=1`)).toBe("/access/[token]/files/x")
    const event = scrubEvent({
      contexts: { nextjs: { request_path: `/access/${TOKEN}` } },
      request: { url: ACCESS_URL },
      transaction: `GET /access/${TOKEN}`,
      breadcrumbs: [{ category: "navigation", data: { from: SUCCESS_URL, to: ACCESS_URL } }],
      exception: { values: [{ value: `boom at ${ACCESS_URL}` }] },
    })
    const serialised = JSON.stringify(event)
    expect(serialised).not.toContain(TOKEN)
    expect(serialised).not.toContain("cs_live_a1B2c3")
  })
})
