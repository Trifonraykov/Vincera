import type { Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { addTopics, horizontalOverflow, onboardedUser } from "./helpers/supply"

/**
 * Ideas and products on a phone ("mobile" project, iPhone 13; CLAUDE.md §19.20, §19.25): reached
 * from the tab bar (or Me), "New …" as the app bar's action, the form's Save draft / Publish in the
 * sticky action bar above the tabs, 16 px fields, and no sideways scrolling at 390 and 360 px.
 */

test.use({ colorScheme: "dark" })

/** Open a role page from its tab when it is one, else from Me (the tab bar follows the build). */
async function openFromShell(page: Page, title: string, path: string) {
  const tabs = page.getByRole("navigation", { name: "Main" })
  const tab = tabs.getByRole("link", { exact: true, name: title })
  if ((await tab.count()) > 0) {
    await tab.click()
    await expect(tab).toHaveAttribute("aria-current", "page")
  } else {
    await tabs.getByRole("link", { exact: true, name: "Me" }).click()
    await page.getByRole("main").getByRole("link", { name: title, exact: true }).click()
  }
  await expect(page).toHaveURL(new RegExp(`${path}$`))
}

async function expectPhoneLayout(page: Page) {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 740 })
    expect(await horizontalOverflow(page), `sideways scroll at ${width}px`).toBeLessThanOrEqual(0)
  }
  await page.setViewportSize({ width: 390, height: 664 })
}

async function expectActionBarAboveTabs(page: Page, buttonName: string) {
  const button = page.getByRole("button", { name: buttonName })
  // A sticky bar sticks once its form is on screen (it cannot rise above the form's top), so
  // bring the start of the form into view first, as a person scrolling down to it would.
  await button.evaluate((element) => {
    element.closest("form")?.scrollIntoView({ block: "start" })
  })
  await expect(button).toBeInViewport()
  const box = await button.boundingBox()
  const tabs = await page.getByRole("navigation", { name: "Main" }).boundingBox()
  expect(box && tabs && box.y + box.height).toBeLessThanOrEqual(tabs?.y ?? 0)
  expect(box?.height).toBeGreaterThanOrEqual(44)
}

test("a creator posts an idea from a phone", async ({ page }) => {
  test.setTimeout(120_000)
  await onboardedUser(page, "creator", "mideas", "Mo Mobile")
  await page.goto("/app")
  await openFromShell(page, "Ideas", "/app/ideas")
  await expect(page.getByRole("heading", { level: 1, name: "Ideas" })).toBeVisible()
  await expectPhoneLayout(page)

  // "New idea" is the app bar's action on phones (44 px), not a header button.
  const appBar = page.locator("[data-app-bar]")
  const newIdea = appBar.getByRole("link", { name: "New idea" })
  await expect(newIdea).toBeVisible()
  expect((await newIdea.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await newIdea.click()
  await expect(page).toHaveURL(/\/app\/ideas\/new$/)
  await expect(appBar).toContainText("New idea")

  // Fields are at least 16 px (no zoom on focus); the actions sit above the tab bar.
  const fontSize = await page
    .getByLabel("Title")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(fontSize).toBeGreaterThanOrEqual(16)
  await expectActionBarAboveTabs(page, "Publish")
  await expectPhoneLayout(page)

  await page.getByLabel("Title").fill("Meal prep planner")
  await page.getByLabel("Format").selectOption({ label: "Template" })
  await page.getByLabel(/^Target price/).fill("12")
  await page.getByRole("button", { name: "Save draft" }).click()
  await expect(page).toHaveURL(/\/app\/ideas\/[0-9a-f-]{36}\?saved=created$/)
  await expect(page.getByText("Saved as a draft.")).toBeVisible()
  await expect(appBar).toContainText("Meal prep planner")

  // Publishing needs the problem and a topic; the errors sit next to the fields.
  await page.getByRole("button", { name: "Publish" }).click()
  await expect(page.getByText("Describe the problem before publishing.")).toBeVisible()
  await page.getByLabel(/^Problem/).fill("People waste food and money every week.")
  await addTopics(page, ["meal prep"])
  await page.getByRole("button", { name: "Publish" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Published." })).toBeVisible()
  await expectPhoneLayout(page)

  // Back to the list: the card, and the filter chips scroll inside their own row.
  await appBar.getByRole("link", { name: "Back" }).click()
  await expect(page).toHaveURL(/\/app\/ideas$/)
  await expect(page.getByRole("link", { name: /Meal prep planner/ })).toContainText("Open")
  const chip = page
    .getByRole("navigation", { name: "Filter ideas by status" })
    .getByRole("link", { name: /Open/ })
  expect((await chip.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await expectPhoneLayout(page)
})

test("a builder lists a product from a phone", async ({ page }) => {
  test.setTimeout(120_000)
  await onboardedUser(page, "builder", "mproducts", "Bea Mobile")
  await page.goto("/app")
  await openFromShell(page, "Products", "/app/products")
  await expect(page.getByText("List your first product")).toBeVisible()
  await expectPhoneLayout(page)

  await page.locator("[data-app-bar]").getByRole("link", { name: "New product" }).click()
  await expect(page).toHaveURL(/\/app\/products\/new$/)
  await expectActionBarAboveTabs(page, "Save draft")
  await expectPhoneLayout(page)

  await page.getByLabel("Title").fill("Habit tracker")
  await page.getByLabel(/^Description/).fill("Tracks habits with streaks.")
  await page.locator("label").filter({ hasText: "Live" }).first().click()
  await page.getByLabel("Format").selectOption({ label: "App" })
  await addTopics(page, ["habits"])
  await page.getByRole("button", { name: "Publish" }).click()
  await expect(page).toHaveURL(/\/app\/products\/[0-9a-f-]{36}\?saved=published$/)
  await expect(
    page.getByRole("region", { name: "Status" }).getByText("Seeking creators", { exact: true }),
  ).toBeVisible()
  await expectPhoneLayout(page)

  // Archive from the phone: a confirmation dialog, then the read-only view.
  await page.getByRole("button", { name: "Archive product" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Archive", exact: true }).click()
  await expect(page.getByRole("button", { name: "Restore as draft" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Description" })).toBeVisible()
  await expectPhoneLayout(page)
})
