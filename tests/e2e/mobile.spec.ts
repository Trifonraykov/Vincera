import { expect, test } from "./fixtures"
import { uniqueEmail } from "./helpers/accounts"
import { chooseRole, signUp } from "./helpers/auth"
import { completeOnboardingInDb } from "./helpers/db"
import { fillCreatorProfile, uniqueHandle } from "./helpers/profiles"

/**
 * The platform on a phone, like a mobile app: a bottom tab bar in the signed-in app with the full
 * menu behind "More", sticky form actions that stay above it, dark mode, no sideways scrolling,
 * and a web app manifest so it installs to the home screen.
 */

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark",
})

async function horizontalOverflow(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
}

test("a creator moves around the app with the bottom tab bar", async ({ page }) => {
  test.setTimeout(90_000)
  const email = uniqueEmail("mobile")
  await signUp(page, email, "Mia Mobile")
  await chooseRole(page, "creator")
  await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)

  // Onboarding has no tab bar; its own action bar holds Continue at the bottom of the screen.
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0)
  const continueButton = page.getByRole("button", { name: "Continue" })
  const continueBox = await continueButton.boundingBox()
  expect(continueBox && continueBox.y + continueBox.height).toBeGreaterThan(844 - 100)
  await fillCreatorProfile(page, { handle: uniqueHandle("mia"), niche: "Phone photography" })
  await continueButton.click()
  await expect(page).toHaveURL(/\/onboarding\/creator\/connect$/)
  await completeOnboardingInDb(email)

  await page.goto("/app")
  await expect(page.locator("html")).toHaveClass(/\bdark\b/)
  const tabs = page.getByRole("navigation", { name: "Main" })
  await expect(tabs).toBeVisible()
  await expect(tabs.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page")
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  // Every tab opens a real page (no 404) and the tab bar stays on screen.
  const expected = [
    { name: "Audience", url: /\/app\/audience$/, heading: "Audience" },
    { name: "Profile", url: /\/app\/settings\/profile$/, heading: "Profile" },
    { name: "Payouts", url: /\/app\/settings\/payouts$/, heading: "Payouts" },
    { name: "Home", url: /\/app$/, heading: "Creator home" },
  ]
  await expect(tabs.getByRole("link")).toHaveText(["Home", "Audience", "Profile", "Payouts"])
  for (const tab of expected) {
    await tabs.getByRole("link", { name: tab.name }).click()
    await expect(page).toHaveURL(tab.url)
    await expect(page.getByRole("heading", { level: 1, name: tab.heading })).toBeVisible()
    await expect(tabs.getByRole("link", { name: tab.name })).toHaveAttribute("aria-current", "page")
    await expect(page.getByText("Page not found")).toHaveCount(0)
  }

  await tabs.getByRole("link", { name: "Audience" }).click()
  await expect(page).toHaveURL(/\/app\/audience$/)
  await expect(tabs.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current")

  // "More" opens the full menu.
  await tabs.getByRole("button", { name: /^More/ }).click()
  const menu = page.getByRole("dialog", { name: "Sidebar" })
  await expect(menu).toBeVisible()
  await menu.getByRole("link", { name: "Settings" }).click()
  await expect(page).toHaveURL(/\/app\/settings\/profile$/)
  await expect(menu).toBeHidden()

  // The profile form's sticky Save bar sits above the tab bar, never under it.
  const save = page.getByRole("button", { name: "Save creator profile" })
  await expect(save).toBeVisible()
  const saveBox = await save.boundingBox()
  const tabsBox = await tabs.boundingBox()
  expect(saveBox && tabsBox && saveBox.y + saveBox.height).toBeLessThanOrEqual(tabsBox?.y ?? 0)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
})

test("pages that don't exist yet keep the app shell and a way back", async ({ page }) => {
  test.setTimeout(60_000)
  // The 404 pages must not log errors either (under `next dev` each one becomes an "Issues" badge
  // over the bottom-left corner, the tab bar's Home). The 404 responses themselves are expected.
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() !== "error") return
    if (/Failed to load resource: .*404/.test(message.text())) return
    consoleErrors.push(message.text())
  })
  const email = uniqueEmail("mobile404")
  await signUp(page, email, "Bo Builder")
  await chooseRole(page, "builder")
  await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)
  await completeOnboardingInDb(email)

  // The builder's tabs only lead to built pages.
  await page.goto("/app")
  const tabs = page.getByRole("navigation", { name: "Main" })
  await expect(tabs.getByRole("link")).toHaveText(["Home", "Profile", "Connections", "Payouts"])
  for (const name of ["Profile", "Connections", "Payouts", "Home"]) {
    await tabs.getByRole("link", { name }).click()
    await expect(tabs.getByRole("link", { name })).toHaveAttribute("aria-current", "page")
    await expect(page.getByText("Page not found")).toHaveCount(0)
  }

  // No link on the home page leads to a missing page; later phases' cards say "Coming soon".
  await expect(page.getByText("Coming soon").first()).toBeVisible()
  const hrefs = await page
    .locator('a[href^="/"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""))
  for (const href of new Set(hrefs)) {
    const response = await page.request.get(href, { maxRedirects: 0 })
    expect(response.status(), href).toBeLessThan(400)
  }

  // A §12 page a later phase builds: "Coming soon" inside the shell, with the tab bar.
  const discover = await page.goto("/app/discover")
  expect(discover?.status()).toBe(404)
  await expect(page.getByRole("heading", { level: 1, name: "Discover" })).toBeVisible()
  await expect(page.getByText("Coming soon", { exact: true })).toBeVisible()
  await expect(tabs).toBeVisible()
  // The menu lists it without a link.
  await tabs.getByRole("button", { name: /^More/ }).click()
  const menu = page.getByRole("dialog", { name: "Sidebar" })
  await expect(menu.getByRole("button", { name: "Discover (coming soon)" })).toBeDisabled()
  await expect(menu.getByRole("link", { name: "Discover" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.getByRole("link", { name: "Go to home" }).click()
  await expect(page).toHaveURL(/\/app$/)

  // A mistyped app URL: "Page not found", still inside the shell.
  expect((await page.goto("/app/no-such-page"))?.status()).toBe(404)
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible()
  await expect(tabs).toBeVisible()
  await tabs.getByRole("link", { name: "Home" }).click()
  await expect(page).toHaveURL(/\/app$/)

  // Outside the app: the site's header and links back.
  expect((await page.goto("/no-such-page"))?.status()).toBe(404)
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible()
  await page.getByRole("link", { name: "Open the app" }).click()
  await expect(page).toHaveURL(/\/app$/)

  // /app/settings has no page of its own; it opens the profile tab.
  await page.goto("/app/settings")
  await expect(page).toHaveURL(/\/app\/settings\/profile$/)
  expect(consoleErrors).toEqual([])
})

test("the web app manifest makes it installable", async ({ page, request }) => {
  await page.goto("/")
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  )
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /viewport-fit=cover/,
  )
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1)

  const response = await request.get("/manifest.webmanifest")
  expect(response.ok()).toBe(true)
  const manifest = (await response.json()) as {
    display: string
    start_url: string
    icons: { src: string; sizes: string; purpose: string }[]
  }
  expect(manifest).toMatchObject({ display: "standalone", start_url: "/app" })
  for (const icon of manifest.icons) {
    const image = await request.get(icon.src)
    expect(image.ok()).toBe(true)
    expect(image.headers()["content-type"]).toBe("image/png")
  }
  const appleIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href")
  expect((await request.get(appleIcon ?? "/missing")).headers()["content-type"]).toBe("image/png")
})
