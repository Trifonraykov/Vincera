import type { Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueEmail } from "./helpers/accounts"
import { chooseRole, signUp } from "./helpers/auth"
import { ADA_CODES_CHANNEL_ID, completeOnboardingInDb, releaseSocialAccount } from "./helpers/db"
import { fillBuilderProfile, fillCreatorProfile, uniqueHandle } from "./helpers/profiles"

/**
 * Every existing page at phone widths ("mobile" project, iPhone 13 on Chromium; 360 px is a small
 * Android phone): nothing scrolls sideways, form fields are at least 16 px (no iOS zoom on focus),
 * buttons take a 44 px tap even when drawn smaller, and the bars respect the screen edges.
 * CLAUDE.md §19, "Mobile app (PWA) patterns".
 */

const WIDTHS = [360, 390] as const

async function expectNoSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const box = element.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) return false
        // Content that scrolls inside its own box (tables, tab strips) is fine.
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const overflowX = getComputedStyle(parent).overflowX
          if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") return false
        }
        return box.right > window.innerWidth + 1
      })
      .slice(0, 3)
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`.slice(0, 120))
    return { by: root.scrollWidth - window.innerWidth, offenders }
  })
  expect(overflow, `${label} at ${page.viewportSize()?.width}px`).toEqual({ by: 0, offenders: [] })
}

async function atEachWidth(page: Page, label: string, check?: () => Promise<void>) {
  const height = page.viewportSize()?.height ?? 664
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height })
    await expectNoSidewaysScroll(page, label)
    await check?.()
  }
}

test("public pages, sign-in and sign-up fit a phone", async ({ page }) => {
  test.setTimeout(120_000)
  const pages = [
    "/",
    "/creators",
    "/builders",
    "/how-it-works",
    "/pricing",
    "/legal/terms",
    "/legal/privacy",
    "/legal/agreement",
    "/offline",
    "/no-such-page",
  ]
  for (const path of pages) {
    await page.goto(path)
    await expect(page.locator("h1").first()).toBeVisible()
    await atEachWidth(page, path)
  }

  for (const path of ["/sign-in", "/sign-up"]) {
    await page.goto(path)
    await atEachWidth(page, path, async () => {
      // 16 px fields: iOS zooms into anything smaller when it gets focus.
      const sizes = await page
        .locator("input:not([type=hidden]):not([type=checkbox]), textarea, select")
        .evaluateAll((fields) =>
          fields.map((field) => parseFloat(getComputedStyle(field).fontSize)),
        )
      expect(sizes.length).toBeGreaterThan(0)
      for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16)
      // Full-width fields.
      const email = await page.getByLabel("Email").boundingBox()
      expect(email?.width).toBeGreaterThan(260)
    })
  }

  // A 36 px button still takes a tap 4 px outside its edge (44 px touch target).
  await page.setViewportSize({ width: 390, height: 664 })
  await page.goto("/sign-in")
  const toggle = page.getByRole("button", { name: "Change theme" })
  const box = await toggle.boundingBox()
  expect(box?.height).toBeLessThan(44)
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label"),
    { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) + 3 },
  )
  expect(hit).toBe("Change theme")
})

test("onboarding steps for both roles fit a phone, with the main action in reach", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const email = uniqueEmail("phone-onb")
  await signUp(page, email, "Pat Phone")
  await expect(page).toHaveURL(/\/onboarding\/role$/)
  await atEachWidth(page, "/onboarding/role")
  await chooseRole(page, "both")

  // The sticky action bar keeps Continue on screen while the long form scrolls.
  await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
  await atEachWidth(page, "/onboarding/creator/profile", async () => {
    const button = await page.getByRole("button", { name: "Continue" }).boundingBox()
    const viewport = page.viewportSize()
    expect(button && button.y + button.height).toBeLessThanOrEqual(viewport?.height ?? 0)
  })
  const handle = uniqueHandle("pat")
  await fillCreatorProfile(page, {
    handle,
    niche: "Budget cooking for students in small kitchens",
    topics: ["meal prep", "budget recipes", "student life"],
    languages: ["English", "Spanish", "Portuguese"],
  })
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(page).toHaveURL(/\/onboarding\/creator\/connect$/)
  await atEachWidth(page, "/onboarding/creator/connect")
  await page.getByRole("button", { name: "Do this later" }).click()

  await expect(page).toHaveURL(/\/onboarding\/creator\/review$/)
  await atEachWidth(page, "/onboarding/creator/review")
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)
  await atEachWidth(page, "/onboarding/builder/profile")
  await fillBuilderProfile(page, { handle, stack: "Next.js, Postgres, Tailwind" })
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(page).toHaveURL(/\/onboarding\/builder\/portfolio$/)
  await atEachWidth(page, "/onboarding/builder/portfolio")
  await page.getByRole("button", { name: "Do this later" }).click()

  await expect(page).toHaveURL(/\/onboarding\/payouts$/)
  await atEachWidth(page, "/onboarding/payouts")
  await page.getByRole("button", { name: "Do this later" }).click()
  await expect(page).toHaveURL(/\/app$/)

  // The signed-in app, every built page, plus the public profiles.
  for (const path of [
    "/app",
    "/app/me",
    "/app/audience",
    "/app/settings/profile",
    "/app/settings/connections",
    "/app/settings/payouts",
    "/app/settings/notifications",
    "/app/settings/account",
    "/app/discover",
    `/c/${handle}`,
    `/b/${handle}`,
  ]) {
    await page.goto(path)
    await expect(page.locator("h1").first()).toBeVisible()
    await atEachWidth(page, path)
  }

  // Both roles: the role switch on Me changes the tabs.
  await page.goto("/app/me")
  const tabs = page.getByRole("navigation", { name: "Main" })
  const before = await tabs.getByRole("link").allTextContents()
  await page.getByRole("button", { name: /^Use as / }).click()
  await expect(tabs.getByRole("link")).not.toHaveText(before)
  await expect(tabs.getByRole("link").last()).toHaveText("Me")
})

test("audience charts, connection cards and a public profile with real data fit a phone", async ({
  page,
}) => {
  test.setTimeout(150_000)
  const email = uniqueEmail("phone-data")
  await signUp(page, email, "Cleo Charts")
  await chooseRole(page, "creator")
  await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
  await completeOnboardingInDb(email)

  // Connect YouTube from Settings → Connections (the fake consent page stands in for Google).
  // The Phase 1 acceptance spec connects the same fixture channel earlier in a full run.
  await releaseSocialAccount("youtube", ADA_CODES_CHANNEL_ID)
  await page.goto("/app/settings/connections")
  const youtube = page.getByRole("region", { name: "YouTube" })
  await youtube.getByRole("link", { name: "Connect YouTube" }).click()
  await page.getByRole("button", { name: /Authorize as Ada Codes/ }).click()
  await expect(page).toHaveURL(/\/app\/settings\/connections\?connected=youtube$/)
  await expect(youtube.getByText("Verified")).toBeVisible({ timeout: 30_000 })
  await expect(youtube).toContainText("48.2K")
  await atEachWidth(page, "/app/settings/connections (YouTube connected)")

  // The audience page's stats, country bars and age chart, then its table view.
  await page.goto("/app/audience")
  await expect(page.getByText("48.2K").first()).toBeVisible()
  await expect(page.getByRole("table", { name: /YouTube: top countries/ })).toBeVisible()
  await atEachWidth(page, "/app/audience (with data)")
  await page.getByText("Show as a table").click()
  await expect(page.getByRole("table", { name: /share of viewers by age group/ })).toBeVisible()
  await atEachWidth(page, "/app/audience (age table)")

  // The public creator profile with its platform numbers.
  await page.goto("/app/me")
  const profile = await page.getByRole("link", { name: /Creator profile/ }).getAttribute("href")
  await page.goto(profile ?? "/missing")
  await expect(page.getByText("48.2K").first()).toBeVisible()
  await atEachWidth(page, "public creator profile (with data)")
})
