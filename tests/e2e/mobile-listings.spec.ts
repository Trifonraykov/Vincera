import { expect, test } from "./fixtures"
import { horizontalOverflow, seededCreator, signInSeeded } from "./helpers/discover"
import { newPerson } from "./helpers/proposals"

/**
 * The creator feed and the builder's import panel on a phone ("mobile" project; CLAUDE.md §19.20,
 * §19.45): the Feed tab, big cards with a 44 px heart, the listing with its sticky "Send a
 * proposal", no sideways scroll at 390 and 360 px, 16 px fields on the import panel.
 */

async function expectNoSidewaysScroll(page: import("@playwright/test").Page) {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 740 })
    expect(await horizontalOverflow(page), `sideways scroll at ${width}px`).toBeLessThanOrEqual(0)
  }
  await page.setViewportSize({ width: 390, height: 664 })
}

test("a creator scrolls the feed and opens a listing on a phone", async ({ page }) => {
  test.setTimeout(120_000)
  await signInSeeded(page, seededCreator(8))
  await page.goto("/app")
  const tabs = page.getByRole("navigation", { name: "Main" })
  const feedTab = tabs.getByRole("link", { exact: true, name: "Feed" })
  await feedTab.click()
  await expect(page).toHaveURL(/\/app\/feed$/)
  await expect(feedTab).toHaveAttribute("aria-current", "page")

  const cards = page.getByRole("list", { name: "Products for you" }).getByRole("article")
  await expect(cards.nth(1)).toBeVisible()
  const first = cards.first()
  const box = await first.boundingBox()
  expect(box?.width).toBeGreaterThan(330)
  const heart = first.getByRole("button", { name: /^Save / })
  const heartBox = await heart.boundingBox()
  expect(heartBox?.height).toBeGreaterThanOrEqual(44)
  await expectNoSidewaysScroll(page)

  await first.getByRole("link", { name: /^Open / }).click()
  await expect(page).toHaveURL(/\/app\/feed\/[0-9a-f-]{36}/)
  const send = page.getByRole("link", { name: "Send a proposal" }).last()
  await expect(send).toBeInViewport()
  await expectNoSidewaysScroll(page)
})

test("a builder's import panel fits a phone", async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const builder = await newPerson(browser, {
    role: "builder",
    name: "Phone Builder",
    baseURL: baseURL ?? "",
    contextOptions: { viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true },
  })
  const page = builder.page
  await page.goto("/app/products")
  const field = page.getByTestId("web-import").getByLabel("Product page")
  await expect(field).toBeVisible()
  const fontSize = await field.evaluate((element) => getComputedStyle(element).fontSize)
  expect(Number.parseFloat(fontSize)).toBeGreaterThanOrEqual(16)
  await field.fill("https://quietnotes.example/")
  await page.getByTestId("web-import").getByRole("button", { name: "Import" }).click()
  await expect(
    page
      .getByRole("region", { name: "Imported listings" })
      .getByRole("link", { name: /Quiet Notes/ }),
  ).toBeVisible({ timeout: 30_000 })
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
})
