import type { Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueEmail } from "./helpers/accounts"
import { chooseRole, signUp } from "./helpers/auth"
import { completeOnboardingInDb, withE2eDb } from "./helpers/db"
import { fillCreatorProfile, uniqueHandle } from "./helpers/profiles"
import { appNav, appTabs, isBuiltRoute } from "@/lib/nav"

/**
 * The signed-in app as a phone app ("mobile" project: an iPhone 13 screen on Chromium): the bottom
 * tab bar (Home, three built pages standing in for Discover/Collabs/Inbox, Me), the compact top app
 * bar with its back button, the Me page that lists everything else, sticky form actions above the
 * tabs, and the shell kept on 404s. CLAUDE.md §19, "Mobile app (PWA) patterns".
 */

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement
    return root.scrollWidth - window.innerWidth
  })
}

/**
 * The tab bar follows the pages built so far (lib/nav.ts `appTabs`): each phase that adds a page
 * changes it, so the expectations come from the same function the shell uses. Headings of the
 * pages a tab can open, where known.
 */
const TAB_HEADINGS: Record<string, string> = {
  "/app/audience": "Audience",
  "/app/ideas": "Ideas",
  "/app/products": "Products",
  "/app/settings/profile": "Profile",
  "/app/settings/connections": "Connections",
  "/app/settings/payouts": "Payouts",
}

test.use({ colorScheme: "dark" })

test("a creator moves around the app with the bottom tabs, the app bar and Me", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const email = uniqueEmail("mobile")
  await signUp(page, email, "Mia Mobile")
  await chooseRole(page, "creator")
  await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)

  // Onboarding has no tab bar; its own action bar holds Continue at the bottom of the screen.
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0)
  const viewport = page.viewportSize()
  const continueButton = page.getByRole("button", { name: "Continue" })
  const continueBox = await continueButton.boundingBox()
  expect(continueBox && continueBox.y + continueBox.height).toBeGreaterThan(
    (viewport?.height ?? 0) - 100,
  )
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
  await fillCreatorProfile(page, { handle: uniqueHandle("mia"), niche: "Phone photography" })
  await continueButton.click()
  await expect(page).toHaveURL(/\/onboarding\/creator\/connect$/)
  await completeOnboardingInDb(email)

  await page.goto("/app")
  await expect(page.locator("html")).toHaveClass(/\bdark\b/)
  const tabs = page.getByRole("navigation", { name: "Main" })
  await expect(tabs).toBeVisible()
  const creatorTabs = appTabs("creator")
  await expect(tabs.getByRole("link")).toHaveText(creatorTabs.map((tab) => tab.title))
  await expect(tabs.getByRole("link", { exact: true, name: "Home" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  // No sidebar on phones: no menu toggle, no sidebar landmark; the app bar has the logo.
  await expect(page.getByRole("button", { name: "Toggle Sidebar" })).toBeHidden()
  const appBar = page.locator("[data-app-bar]")
  await expect(appBar).toBeVisible()
  await expect(appBar.getByRole("link", { name: /home$/ })).toBeVisible()
  await expect(appBar.getByRole("link", { name: "Back" })).toHaveCount(0)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  // Every tab opens a real page (no 404), the tab bar stays, and touch targets are big enough.
  const expected = [
    ...creatorTabs
      .filter((tab) => tab.id !== "home" && tab.id !== "me")
      .map((tab) => ({ name: tab.title, path: tab.href, heading: TAB_HEADINGS[tab.href] })),
    { name: "Me", path: "/app/me", heading: "Mia Mobile" },
    { name: "Home", path: "/app", heading: "Creator home" },
  ]
  for (const tab of expected) {
    const link = tabs.getByRole("link", { exact: true, name: tab.name })
    const box = await link.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    expect(box?.width).toBeGreaterThanOrEqual(44)
    await link.click()
    await expect(page).toHaveURL(new RegExp(`${tab.path.replaceAll("/", "\\/")}$`))
    await expect(
      tab.heading
        ? page.getByRole("heading", { level: 1, name: tab.heading })
        : page.getByRole("heading", { level: 1 }),
    ).toBeVisible()
    await expect(link).toHaveAttribute("aria-current", "page")
    await expect(page.getByText("Page not found")).toHaveCount(0)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
  }

  // Me lists everything else: later phases' pages as "Soon", every settings page, sign out.
  await tabs.getByRole("link", { exact: true, name: "Me" }).click()
  await expect(page).toHaveURL(/\/app\/me$/)
  await expect(appBar).toContainText("Me")
  const me = page.locator("main")
  // Pages of later phases: listed, marked "Soon", not links.
  const soonRows = me.locator("[data-coming-soon]")
  const later = [
    ["Ideas", "/app/ideas"],
    ["Discover", "/app/discover"],
    ["Proposals", "/app/proposals"],
    ["Collabs", "/app/collabs"],
    ["Messages", "/app/messages"],
    ["Earnings", "/app/earnings"],
  ].filter(([, href]) => !isBuiltRoute(href ?? ""))
  for (const [soon] of later) {
    await expect(soonRows.filter({ hasText: soon })).toContainText(["Soon"])
  }
  await expect(soonRows.getByRole("link")).toHaveCount(0)
  await expect(me.getByRole("link", { name: /Creator profile/ })).toHaveAttribute(
    "href",
    /^\/c\/mia_/,
  )
  await expect(me.getByRole("button", { name: "Sign out" })).toBeVisible()

  // A settings page from Me: the tab bar marks Me, and the app bar has a back button to Me.
  await me.getByRole("link", { name: "Account", exact: true }).click()
  await expect(page).toHaveURL(/\/app\/settings\/account$/)
  // The settings tab strip scrolls sideways on a phone and brings the current tab into view.
  await expect(
    page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Account" }),
  ).toBeInViewport({ ratio: 1 })
  await expect(tabs.getByRole("link", { exact: true, name: "Me" })).toHaveAttribute(
    "aria-current",
    "true",
  )
  await expect(appBar).toContainText("Account")
  await appBar.getByRole("link", { name: "Back" }).click()
  await expect(page).toHaveURL(/\/app\/me$/)

  // Appearance lives on Me: switching to light mode applies at once.
  await page.getByRole("button", { name: "Light", exact: true }).click()
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)
  await expect(page.getByRole("button", { name: "Light", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  )

  // The profile form's sticky Save bar sits above the tab bar, never under it.
  await page.goto("/app/settings/profile")
  const save = page.getByRole("button", { name: "Save creator profile" })
  await expect(save).toBeVisible()
  const saveBox = await save.boundingBox()
  const tabsBox = await tabs.boundingBox()
  expect(saveBox && tabsBox && saveBox.y + saveBox.height).toBeLessThanOrEqual(tabsBox?.y ?? 0)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  // Sign out from Me.
  await tabs.getByRole("link", { exact: true, name: "Me" }).click()
  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(page).toHaveURL(/\/$/)
})

test("a builder's tabs, and pages that don't exist yet keep the shell and a way back", async ({
  page,
}) => {
  test.setTimeout(90_000)
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
  const builderTabs = appTabs("builder").map((tab) => tab.title)
  await expect(tabs.getByRole("link")).toHaveText(builderTabs)
  for (const name of [...builderTabs.slice(1), "Home"]) {
    await tabs.getByRole("link", { name, exact: true }).click()
    await expect(tabs.getByRole("link", { name, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    )
    await expect(page.getByText("Page not found")).toHaveCount(0)
  }

  // No link on the home page or on Me leads to a missing page; later phases say "Coming soon".
  for (const path of ["/app", "/app/me"]) {
    await page.goto(path)
    const hrefs = await page
      .locator('main a[href^="/"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""))
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of new Set(hrefs)) {
      const response = await page.request.get(href, { maxRedirects: 0 })
      expect(response.status(), href).toBeLessThan(400)
    }
  }

  // A §12 page a later phase builds: "Coming soon" inside the shell, with the tabs and a back
  // button (to Me, which lists it). Since Phases 4–5 every builder menu page exists, so this
  // runs again only if a planned page joins the builder's menu.
  const planned = appNav("builder")
    .flatMap((section) => section.items)
    .find((item) => !isBuiltRoute(item.href))
  const appBar = page.locator("[data-app-bar]")
  if (planned) {
    const soon = await page.goto(planned.href)
    expect(soon?.status()).toBe(404)
    await expect(page.getByRole("heading", { level: 1, name: planned.title })).toBeVisible()
    await expect(page.getByText("Coming soon", { exact: true })).toBeVisible()
    await expect(tabs).toBeVisible()
    await expect(appBar).toContainText(planned.title)
    await appBar.getByRole("link", { name: "Back" }).click()
    await expect(page).toHaveURL(/\/app\/me$/)
  }

  // A mistyped app URL: "Page not found", still inside the shell.
  expect((await page.goto("/app/no-such-page"))?.status()).toBe(404)
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible()
  await expect(tabs).toBeVisible()
  // The page names itself in the app bar (<AppBarSlot>), with a back button home.
  await expect(appBar).toContainText("Page not found")
  await expect(appBar.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/app")
  await tabs.getByRole("link", { exact: true, name: "Home" }).click()
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

test("the admin area works at phone width, with its menu in a sheet", async ({ page }) => {
  test.setTimeout(60_000)
  const email = uniqueEmail("mobileadmin")
  await signUp(page, email, "Ada Admin")
  await chooseRole(page, "builder")
  await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)
  await completeOnboardingInDb(email)
  await withE2eDb((pool) =>
    pool.query(
      "UPDATE users SET roles = array_append(roles, 'admin') WHERE email = $1 AND NOT 'admin' = ANY(roles)",
      [email],
    ),
  )

  // Me links to the admin area.
  await page.goto("/app/me")
  await page.getByRole("link", { name: "Admin area" }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole("heading", { level: 1, name: "Admin overview" })).toBeVisible()
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  await page.getByRole("button", { name: "Open the admin menu" }).click()
  const menu = page.getByRole("dialog", { name: "Sidebar" })
  await expect(menu).toBeVisible()
  const overview = menu.getByRole("link", { name: "Overview" })
  expect((await overview.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await expect(menu.getByRole("button", { name: "Users (coming soon)" })).toBeDisabled()
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
})
