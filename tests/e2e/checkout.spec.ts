import { latestEmailTo, extractUrls } from "@/lib/email/outbox"

import { expect, test } from "./fixtures"
import { buyerEmail, insertLiveKeyLaunch, orderOf, payOnFakeCheckout } from "./helpers/checkout"

/**
 * §16 Phase 4 acceptance, checkout side (CLAUDE.md §19.34), on the desktop layout: "a test
 * purchase via a tracked link creates an attributed order, and the buyer gets working access".
 * A buyer (no account) clicks the creator's tracked link, buys on the product page, pays on the
 * fake Stripe Checkout (which delivers signed webhooks to the real handler), lands on the success
 * page, and opens the purchase from there and from the receipt email.
 */

test("a purchase through a tracked link is attributed and the buyer gets access", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const launch = await insertLiveKeyLaunch()
  const email = buyerEmail()

  // The tracked link sets the attribution cookie and lands on the product page.
  await page.goto(`/r/${launch.linkCode}`)
  await expect(page).toHaveURL(new RegExp(`/p/${launch.slug}\\?ref=${launch.linkCode}`))
  await expect(page.getByRole("heading", { level: 1, name: launch.title })).toBeVisible()
  const cookies = await page.context().cookies()
  expect(cookies.find((cookie) => cookie.name === "attr")?.value).toBe(launch.linkId)

  // Buy → the fake Stripe Checkout page shows the product and the VAT it includes.
  await page.getByRole("button", { name: /Buy for/ }).click()
  await expect(page.getByText(launch.title)).toBeVisible()
  await expect(page.getByText(/VAT included/)).toBeVisible()
  await payOnFakeCheckout(page, email, "DE")

  // The success page: paid, "check your email", and the way into the purchase.
  await expect(page).toHaveURL(new RegExp(`/p/${launch.slug}/success\\?session_id=cs_fake_`))
  await expect(
    page.getByRole("heading", { name: "Thanks, your payment went through" }),
  ).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText("Check your email")).toBeVisible()

  const order = await orderOf(launch.launchId, email)
  expect(order).toMatchObject({
    status: "paid",
    amount_gross_cents: 1900,
    tax_cents: 303,
    stripe_fee_cents: 54,
    tracked_link_id: launch.linkId,
    attribution: "cookie",
    ledger_posted: true,
    ledger_sum: 1900,
  })
  expect(order?.license_key).toMatch(/^FOCUS-/)

  await page.getByRole("link", { name: "Open your purchase" }).click()
  await expect(page).toHaveURL(/\/access\/[A-Za-z0-9_-]{43}$/)
  await expect(page.getByRole("heading", { name: "Your license key" })).toBeVisible()
  await expect(page.getByText(order?.license_key ?? "-")).toBeVisible()
  await expect(page.getByText("Paste the key in Settings → License.")).toBeVisible()

  // The receipt email carries the same access link.
  await expect
    .poll(async () => (await latestEmailTo(email))?.subject ?? null)
    .toBe(`Your purchase: ${launch.title}`)
  const receipt = await latestEmailTo(email)
  const accessUrl = receipt ? extractUrls(receipt).find((url) => url.includes("/access/")) : null
  expect(accessUrl).toBeTruthy()
  await page.goto(new URL(accessUrl ?? "/").pathname)
  await expect(page.getByText(order?.license_key ?? "-")).toBeVisible()

  // Unknown access tokens are 404s.
  const missing = await page.goto(`/access/${"A".repeat(43)}`)
  expect(missing?.status()).toBe(404)
})

test("a launch out of keys answers Sold out and charges nothing", async ({ page }) => {
  const launch = await insertLiveKeyLaunch("Sold out timer")
  const { withE2eDb } = await import("./helpers/db")
  await withE2eDb((pool) =>
    pool.query("DELETE FROM license_keys WHERE launch_id = $1 AND order_id IS NULL", [
      launch.launchId,
    ]),
  )
  await page.goto(`/p/${launch.slug}`)
  await page.getByRole("button", { name: /Buy for/ }).click()
  await expect(page.getByRole("heading", { name: "Sold out" })).toBeVisible()
  await expect(page.getByText("Nothing was charged")).toBeVisible()
})
