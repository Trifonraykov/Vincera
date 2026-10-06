import { expect, test } from "./fixtures"
import {
  buyerEmail,
  insertLiveKeyLaunch,
  orderOf,
  payOnFakeCheckout,
  sidewaysOverflow,
} from "./helpers/checkout"

/**
 * The buyer's path on a phone (`mobile` project; CLAUDE.md §19.20, §19.34): product page → fake
 * Stripe Checkout → success → access, at 390 and 360 px wide: no sideways scroll, 44 px targets
 * and 16 px fields on the fake checkout, the key readable and copyable.
 */

test("a buyer pays and opens the purchase on a phone", async ({ page }) => {
  test.setTimeout(120_000)
  const launch = await insertLiveKeyLaunch("Pocket focus timer")
  const email = buyerEmail()

  await page.goto(`/r/${launch.linkCode}`)
  await expect(page.getByRole("heading", { level: 1, name: launch.title })).toBeVisible()
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0)

  const buy = page.getByRole("button", { name: /Buy for/ })
  expect((await buy.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await buy.click()

  await page.waitForURL(/\/api\/dev\/fake-stripe\/checkout\//)
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0)
  const pay = page.getByRole("button", { name: "Pay with test card 4242" })
  expect((await pay.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  const fontSize = await page
    .getByLabel("Email")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(fontSize).toBeGreaterThanOrEqual(16)
  await payOnFakeCheckout(page, email, "ES")

  await expect(
    page.getByRole("heading", { name: "Thanks, your payment went through" }),
  ).toBeVisible({ timeout: 20_000 })
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0)
  const open = page.getByRole("link", { name: "Open your purchase" })
  expect((await open.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await open.click()

  const order = await orderOf(launch.launchId, email)
  await expect(page.getByText(order?.license_key ?? "-")).toBeVisible()
  const copy = page.getByRole("button", { name: "Copy your license key" })
  expect((await copy.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 740 })
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0)
  }
})
