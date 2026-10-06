import { devices, type Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { insertPaidSale } from "./helpers/payouts"
import { horizontalOverflow, newPerson } from "./helpers/proposals"

/**
 * Earnings on a phone ("mobile" project, iPhone 13; CLAUDE.md §19.20, §19.35): both earnings pages
 * reachable from Me, inside the shell, without sideways scrolling at 390 and 360 px, with 44 px
 * tabs between them.
 */

test.use({ colorScheme: "dark" })

const { defaultBrowserType: _browserType, ...PHONE } = devices["iPhone 13"]

async function fitsPhone(page: Page, label: string) {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 740 })
    expect(await horizontalOverflow(page), `${label} at ${width}px`).toBeLessThanOrEqual(0)
  }
  await page.setViewportSize({ width: 390, height: 664 })
}

test("earnings and payouts on a phone", async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const phone = { ...PHONE, colorScheme: "dark" as const }
  const creator = await newPerson(browser, {
    role: "creator",
    name: "Pocket Creator",
    baseURL,
    contextOptions: phone,
  })
  const builder = await newPerson(browser, {
    role: "builder",
    name: "Pocket Builder",
    baseURL,
    contextOptions: phone,
  })
  await insertPaidSale({
    creatorUserId: creator.userId,
    builderUserId: builder.userId,
    paidAt: new Date(Date.now() - 60_000),
  })

  const page = creator.page
  await page.goto("/app/me")
  await page
    .getByRole("link", { name: /^Earnings/ })
    .first()
    .click()
  await expect(page).toHaveURL(/\/app\/earnings$/)
  await expect(page.getByRole("heading", { level: 1, name: "Earnings" })).toBeVisible()
  await expect(page.getByText("€26.46").first()).toBeVisible()
  // Not payouts-ready yet: the page points to the payout settings.
  await expect(page.getByRole("link", { name: "Payout settings" })).toBeVisible()
  await fitsPhone(page, "/app/earnings")

  const tab = page.getByRole("navigation", { name: "Earnings" }).getByRole("link", {
    name: "Payouts",
  })
  const box = await tab.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  await tab.click()
  await expect(page).toHaveURL(/\/app\/earnings\/payouts$/)
  await expect(page.getByText("No payouts yet")).toBeVisible()
  await fitsPhone(page, "/app/earnings/payouts")
})
