import { describe, expect, it } from "vitest"

import { isBotUserAgent } from "@/lib/attribution/bots"
import { BASE62_ALPHABET, generateLinkCode } from "@/lib/attribution/code"
import { TRACKED_LINK_CODE_PATTERN } from "@/lib/attribution/cookie"
import { checkoutAction, viewBeaconUrl } from "@/components/launches/product-page-client"

/** Tracked link codes, bot detection and the Buy form's forwarded parameters (§10, §19.32). */

describe("tracked link codes", () => {
  it("are 8 base62 characters matching the database format", () => {
    for (let n = 0; n < 200; n += 1) {
      const code = generateLinkCode()
      expect(code).toMatch(TRACKED_LINK_CODE_PATTERN)
      expect(code).toMatch(/^[0-9A-Za-z]{8}$/)
    }
  })

  it("drops biased bytes (≥ 248) instead of wrapping them", () => {
    const bytes = [255, 248, 0, 61, 62, 247, 1, 2, 3, 4, 5]
    const code = generateLinkCode(() => Uint8Array.from(bytes.splice(0, 16)))
    expect(code).toBe(`0${BASE62_ALPHABET[61]}0${BASE62_ALPHABET[247 % 62]}1234`)
  })

  it("spreads characters over the whole alphabet", () => {
    const seen = new Set<string>()
    for (let n = 0; n < 500; n += 1) for (const char of generateLinkCode()) seen.add(char)
    expect(seen.size).toBe(62)
  })
})

describe("bot user agents", () => {
  it.each([
    "",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "WhatsApp/2.23.20.0",
    "TelegramBot (like TwitterBot)",
    "Slackbot-LinkExpanding 1.0",
    "curl/8.4.0",
    "python-requests/2.31.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0)",
  ])("flags %j", (ua) => {
    expect(isBotUserAgent(ua)).toBe(true)
  })

  it.each([
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 13; CUBOT X70) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0",
  ])("lets people through: %j", (ua) => {
    expect(isBotUserAgent(ua)).toBe(false)
  })
})

describe("the Buy form", () => {
  it("forwards only well-formed ref and code parameters", () => {
    expect(checkoutAction("planner", "")).toBe("/p/planner/checkout")
    expect(checkoutAction("planner", "?ref=Ab12Cd34&code=SAVE10&utm=x")).toBe(
      "/p/planner/checkout?ref=Ab12Cd34&code=SAVE10",
    )
    expect(checkoutAction("planner", "?ref=<script>")).toBe("/p/planner/checkout")
  })
})

describe("the view beacon", () => {
  it("forwards a well-formed ref so views are attributed like checkouts", () => {
    expect(viewBeaconUrl("planner", "")).toBe("/p/planner/view")
    expect(viewBeaconUrl("planner", "?ref=Ab12Cd34&code=SAVE10")).toBe(
      "/p/planner/view?ref=Ab12Cd34",
    )
    expect(viewBeaconUrl("planner", "?ref=<script>")).toBe("/p/planner/view")
  })
})
