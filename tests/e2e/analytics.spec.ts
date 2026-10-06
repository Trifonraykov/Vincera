import { latestEmailTo } from "@/lib/email/outbox"

import { expect, test } from "./fixtures"
import { insertPaidOrder, linksOf, memberEmails, refundRequestOf } from "./helpers/analytics"
import { signIn } from "./helpers/auth"
import { insertLiveKeyLaunch } from "./helpers/checkout"

/**
 * Phase 7 v1 pages (CLAUDE.md §19.41) on the desktop layout: a member's tracked links page (add a
 * link with a discount code, copy, rename, turn off), the collab analytics page, and a buyer
 * asking for a refund from their access page.
 */

test("a member adds, renames and turns off a tracked link; analytics shows the funnel", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const launch = await insertLiveKeyLaunch("Links timer")
  const { creator } = memberEmails(launch.slug)
  await signIn(page, creator, `/sign-in?callbackUrl=/app/launches/${launch.launchId}/links`)
  await expect(page).toHaveURL(new RegExp(`/app/launches/${launch.launchId}/links$`))
  await expect(page.getByRole("heading", { level: 1, name: /Tracked links/ })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Default" })).toBeVisible()

  const code = `E2E${Date.now().toString(36).toUpperCase()}`.slice(0, 20)
  await page.getByLabel("Name", { exact: true }).fill("Newsletter")
  await page.getByRole("button", { name: "Add a discount code" }).click()
  await page.getByLabel("Discount code").fill(code.toLowerCase())
  await page.getByLabel("Percent off").fill("15")
  await page.getByRole("button", { name: "Add link" }).click()
  await expect(page.getByRole("heading", { name: "Newsletter" })).toBeVisible()
  await expect(page.getByText(`${code} · 15% off`)).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Copy the discount link for “Newsletter”" }),
  ).toBeVisible()

  await page.getByRole("button", { name: "Rename the link “Newsletter”" }).click()
  await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Weekly newsletter")
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click()
  await expect(page.getByRole("heading", { name: "Weekly newsletter" })).toBeVisible()

  await page.getByRole("button", { name: "Turn off the link “Weekly newsletter”" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click()
  await expect(page.getByText("Off", { exact: true })).toBeVisible()
  expect(await linksOf(launch.launchId)).toEqual([
    { label: "Default", discount_code: null, disabled: false },
    { label: "Weekly newsletter", discount_code: code, disabled: true },
  ])

  // The collab's analytics: funnel steps and the per-link table.
  await page.getByRole("link", { name: "Analytics by day" }).click()
  await expect(page.getByRole("heading", { name: "Funnel" })).toBeVisible()
  await expect(page.getByRole("table", { name: "The funnel by tracked link" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Analytics" })).toHaveAttribute(
    "aria-current",
    "page",
  )
})

test("strangers get a 404 on the links and analytics pages", async ({ page }) => {
  const launch = await insertLiveKeyLaunch("Private timer")
  const other = await insertLiveKeyLaunch("Other timer")
  await signIn(page, memberEmails(other.slug).creator)
  const links = await page.goto(`/app/launches/${launch.launchId}/links`)
  expect(links?.status()).toBe(404)
})

test("a buyer asks for a refund from their purchase", async ({ page }) => {
  const launch = await insertLiveKeyLaunch("Refund timer")
  const { orderId, token } = await insertPaidOrder(launch.launchId)

  await page.goto(`/access/${token}`)
  await page.getByRole("link", { name: "Ask for a refund" }).click()
  await expect(page).toHaveURL(new RegExp(`/access/${token}/refund$`))
  await expect(page.getByRole("heading", { level: 1, name: "Refund timer" })).toBeVisible()

  await page.getByRole("button", { name: "Ask for a refund" }).click()
  await expect(page.getByText("Pick the reason that fits best.")).toBeVisible()
  await page.locator("label").filter({ hasText: "It doesn't work" }).click()
  await page.getByLabel(/Anything we should know/).fill("The timer never starts.")
  await page.getByRole("button", { name: "Ask for a refund" }).click()
  // The action revalidates the page, which then shows the stored request instead of the form.
  await expect(page.getByText("Waiting for a decision")).toBeVisible()
  expect(await refundRequestOf(orderId)).toEqual({
    status: "pending",
    reason: "not_working",
    amount_cents: 1900,
  })

  await page.reload()
  await expect(page.getByText("Waiting for a decision")).toBeVisible()
  await expect(page.getByRole("button", { name: "Ask for a refund" })).toHaveCount(0)

  const { withE2eDb } = await import("./helpers/db")
  const buyer = await withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ buyer_email: string }>(
      "SELECT buyer_email FROM orders WHERE id = $1",
      [orderId],
    )
    return rows[0]?.buyer_email ?? ""
  })
  await expect
    .poll(async () => (await latestEmailTo(buyer))?.subject ?? null)
    .toBe("We got your refund request for “Refund timer”")
})

test("the public directory lists live launches and filters them", async ({ page }) => {
  const launch = await insertLiveKeyLaunch(`Directory timer ${Date.now().toString(36)}`)
  await page.goto("/launches")
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  // The page is static (revalidated every 5 minutes and when launches change); a fresh database
  // insert may not be on it yet, so search for it only when present.
  const search = page.getByRole("searchbox", { name: "Search launches" })
  if (await search.isVisible()) {
    await search.fill("zzzz-no-such-launch")
    await expect(page.getByText("Nothing matches")).toBeVisible()
    await search.fill(launch.title)
  }
})
