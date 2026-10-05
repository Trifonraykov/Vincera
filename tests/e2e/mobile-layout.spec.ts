import type { Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueEmail } from "./helpers/accounts"
import { chooseRole, signUp } from "./helpers/auth"
import { completeOnboardingInDb, withE2eDb } from "./helpers/db"
import { fillCreatorProfile, uniqueHandle } from "./helpers/profiles"

/**
 * Phone layout details ("mobile" project, an iPhone 13 on Chromium): the browser and status bar
 * colour across client-side navigations, toasts above the tab bar at tablet widths, focused fields
 * clear of the sticky Save bar, the safe areas around the sidebar (the admin menu sheet, and the
 * desktop layout on a phone in landscape), and the iPhone install steps per browser. CLAUDE.md §19,
 * "Mobile app (PWA) patterns".
 */

test.use({ colorScheme: "light" })

const LIGHT = "#ffffff"
const DARK = "#0a0a0a"

async function themeColors(page: Page): Promise<string[]> {
  return page
    .locator('meta[name="theme-color"]')
    .evaluateAll((metas) => metas.map((meta) => meta.getAttribute("content") ?? ""))
}

/** An onboarded creator on /app. */
async function creatorAtHome(page: Page, prefix: string, name: string): Promise<string> {
  const email = uniqueEmail(prefix)
  await signUp(page, email, name)
  await chooseRole(page, "creator")
  await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
  await fillCreatorProfile(page, { handle: uniqueHandle(prefix.slice(0, 6)), niche: "Phones" })
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page).toHaveURL(/\/onboarding\/creator\/connect$/)
  await completeOnboardingInDb(email)
  await page.goto("/app")
  await expect(page.getByRole("heading", { level: 1, name: "Creator home" })).toBeVisible()
  return email
}

/** Safe-area insets as on a notched phone (Chromium's emulation; needs viewport-fit=cover). */
async function emulateSafeArea(
  page: Page,
  insets: { top?: number; right?: number; bottom?: number; left?: number },
): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: 0, right: 0, bottom: 0, left: 0, ...insets },
  })
}

test("the status bar keeps the chosen theme across tab taps and on every page", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await creatorAtHome(page, "themebar", "Theo Theme")
  // The phone is in light mode and the app follows it: both tags (one per color scheme) light.
  await expect.poll(() => themeColors(page)).toEqual([LIGHT, LIGHT])

  // Picking Dark on Me paints both theme-color tags dark…
  const tabs = page.getByRole("navigation", { name: "Main" })
  await tabs.getByRole("link", { exact: true, name: "Me" }).click()
  await page.getByRole("button", { name: "Dark", exact: true }).click()
  await expect(page.locator("html")).toHaveClass(/\bdark\b/)
  await expect.poll(() => themeColors(page)).toEqual([DARK, DARK])

  // …and a tab tap (a client-side navigation, which re-renders the tags) keeps them dark.
  await tabs.getByRole("link", { exact: true, name: "Home" }).click()
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole("heading", { level: 1, name: "Creator home" })).toBeVisible()
  await expect.poll(() => themeColors(page)).toEqual([DARK, DARK])
  await tabs.getByRole("link", { exact: true, name: "Profile" }).click()
  await expect(page).toHaveURL(/\/app\/settings\/profile$/)
  await expect.poll(() => themeColors(page)).toEqual([DARK, DARK])

  // Pages outside the app shell follow the choice too: sign-in and the public profile.
  const handle = await page.getByLabel("Handle").inputValue()
  await page.goto(`/c/${handle}`)
  await expect.poll(() => themeColors(page)).toEqual([DARK, DARK])
  await page.goto("/sign-in")
  await expect.poll(() => themeColors(page)).toEqual([DARK, DARK])
})

test("toasts sit above the tab bar at tablet widths too", async ({ page }) => {
  test.setTimeout(90_000)
  await creatorAtHome(page, "toastbar", "Tess Toast")
  // An iPad mini in portrait: the phone layout (tab bar) up to 767px, sonner's desktop offsets
  // from 601px.
  await page.setViewportSize({ width: 744, height: 1133 })
  const tabs = page.getByRole("navigation", { name: "Main" })
  await expect(tabs).toBeVisible()

  // Chrome's install event, accepted: the app confirms with a toast. The listener starts after
  // hydration, so the event is sent until the card switches to its Install button.
  const card = page.getByRole("complementary", { name: "Install the app" })
  await expect(card).toBeVisible()
  const install = card.getByRole("button", { name: "Install", exact: true })
  await expect(async () => {
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", { cancelable: true })
      Object.assign(event, {
        prompt: async () => undefined,
        userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
      })
      window.dispatchEvent(event)
    })
    await expect(install).toBeVisible({ timeout: 1_000 })
  }).toPass()
  await install.click()
  const toast = page.getByText("Installed. Find the app on your home screen.")
  await expect(toast).toBeVisible()
  // Wait for the enter animation to settle before measuring.
  await expect
    .poll(async () => {
      const [toastBox, tabsBox] = await Promise.all([toast.boundingBox(), tabs.boundingBox()])
      return toastBox && tabsBox ? toastBox.y + toastBox.height <= tabsBox.y : false
    })
    .toBe(true)
})

test("tabbing through a form never leaves the focused field under the Save bar", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await creatorAtHome(page, "focusbar", "Fay Focus")
  await page.setViewportSize({ width: 360, height: 640 })
  await page.goto("/app/settings/profile")
  const actions = page.locator("[data-form-actions]")
  await expect(actions).toBeVisible()

  await page.locator("main h1").click()
  let checked = 0
  for (let i = 0; i < 40 && checked < 12; i++) {
    await page.keyboard.press("Tab")
    const report = await page.evaluate(() => {
      const element = document.activeElement
      if (!(element instanceof HTMLElement)) return null
      const field = element.matches("input, textarea, select, [role=combobox]")
      if (!field || !element.closest("main form") || element.closest("[data-form-actions]")) {
        return null
      }
      const box = element.getBoundingClientRect()
      if (box.height === 0) return null
      const bar = document.querySelector("[data-form-actions]")?.getBoundingClientRect()
      const top = document.querySelector("[data-app-bar]")?.getBoundingClientRect()
      return {
        name: element.getAttribute("name") ?? element.id,
        top: box.top,
        bottom: box.bottom,
        barTop: bar?.top ?? window.innerHeight,
        appBarBottom: top?.bottom ?? 0,
      }
    })
    if (!report) continue
    checked++
    // Fully visible between the app bar and the Save bar.
    expect([report.name, report.bottom <= report.barTop + 1]).toEqual([report.name, true])
    expect([report.name, report.top >= report.appBarBottom - 1]).toEqual([report.name, true])
  }
  expect(checked).toBeGreaterThanOrEqual(5)
})

test("the admin menu and the landscape layout keep clear of the notch and home indicator", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const email = uniqueEmail("safeadmin")
  await signUp(page, email, "Sid Safe")
  await chooseRole(page, "builder")
  await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)
  await completeOnboardingInDb(email)
  await withE2eDb((pool) =>
    pool.query(
      "UPDATE users SET roles = array_append(roles, 'admin') WHERE email = $1 AND NOT 'admin' = ANY(roles)",
      [email],
    ),
  )

  // Portrait: the admin menu is a sheet; its footer (the account menu) clears the home indicator.
  await emulateSafeArea(page, { top: 47, bottom: 34 })
  await page.goto("/admin")
  await expect(page.getByRole("heading", { level: 1, name: "Admin overview" })).toBeVisible()
  await page.getByRole("button", { name: "Open the admin menu" }).click()
  const menu = page.getByRole("dialog", { name: "Sidebar" })
  await expect(menu).toBeVisible()
  const account = menu.locator('[data-slot="sidebar-footer"] button').first()
  await expect(account).toBeVisible()
  const viewport = page.viewportSize()
  const accountBox = await account.boundingBox()
  expect(accountBox && accountBox.y + accountBox.height).toBeLessThanOrEqual(
    (viewport?.height ?? 0) - 34,
  )
  const firstLink = menu.getByRole("link", { name: "Overview" })
  expect((await firstLink.boundingBox())?.y).toBeGreaterThanOrEqual(47)
  await page.keyboard.press("Escape")

  // Landscape: wide enough for the desktop layout; the notch on the left, the rounded corner on
  // the right, the home indicator below.
  await page.setViewportSize({ width: 844, height: 390 })
  await emulateSafeArea(page, { left: 47, right: 47, bottom: 21 })
  await page.reload()
  const sidebar = page.locator('[data-slot="sidebar-container"]')
  await expect(sidebar).toBeVisible()
  const overview = sidebar.getByRole("link", { name: "Overview" })
  await expect(overview).toBeVisible()
  expect((await overview.boundingBox())?.x).toBeGreaterThanOrEqual(47)
  const footer = sidebar.locator('[data-slot="sidebar-footer"] button').first()
  const footerBox = await footer.boundingBox()
  expect(footerBox && footerBox.y + footerBox.height).toBeLessThanOrEqual(390 - 21)
  const headerControls = page.locator('[data-slot="sidebar-inset"] > header').getByRole("button")
  const lastControl = await headerControls.last().boundingBox()
  expect(lastControl && lastControl.x + lastControl.width).toBeLessThanOrEqual(844 - 47)
  // The page itself does not scroll sideways.
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement
    return root.scrollWidth - window.innerWidth
  })
  expect(overflow).toBeLessThanOrEqual(0)
})

test.describe("in an app's built-in browser (Instagram on an iPhone)", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.29.92 (iPhone14,5; iOS 18_0; en_US; en; scale=3.00; 1170x2532; 123456789)",
  })

  test("no Safari steps: the app says to open the page in Safari", async ({ page }) => {
    test.setTimeout(90_000)
    await creatorAtHome(page, "inapp", "Ira Inapp")
    await expect(page.getByRole("complementary", { name: "Install the app" })).toHaveCount(0)
    await page.goto("/app/me")
    await expect(page.locator("main li", { hasText: "Install the app" })).toContainText(
      "Open this page in Safari to install",
    )
  })
})

test.describe("in Chrome on an iPhone", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1",
  })

  test("the steps point at Chrome's Share button", async ({ page }) => {
    test.setTimeout(90_000)
    await creatorAtHome(page, "crios", "Cris Chrome")
    const card = page.getByRole("complementary", { name: "Install the app" })
    await card.getByRole("button", { name: "Show me how" }).click()
    const steps = page.getByRole("dialog", { name: "Add the app to your home screen" })
    await expect(steps).toContainText("Two taps in Chrome")
    await expect(steps).toContainText("Share in the address bar")
    await expect(steps).not.toContainText("Safari")
  })
})
