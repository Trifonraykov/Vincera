import { latestEmailTo } from "@/lib/email/outbox"
import { newId } from "@/lib/ids"

import { expect, test } from "./fixtures"
import { setUpPayouts } from "./helpers/collabs"
import { runJob } from "./helpers/jobs"
import { insertPaidSale, SALE, transfersOf } from "./helpers/payouts"
import { newPerson } from "./helpers/proposals"

/**
 * The payout job after the hold period (§15 step 5 "the payout job transfers after the hold
 * (clock mocked)", §16 Phase 5; CLAUDE.md §19.35): a creator with fake Stripe payouts and a paid,
 * posted sale sees it in the hold period on /app/earnings; the payout job run through
 * `/api/test/jobs/payouts-release` with the clock a day later pays nothing, and with the clock
 * past the hold transfers the creator's share once. The builder has no payouts account, so their
 * share waits. Buyer emails never appear on the earnings pages.
 */

const DAY_MS = 24 * 60 * 60 * 1000

test("the payout job transfers a creator's share after the hold", async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const creator = await newPerson(browser, { role: "creator", name: "Payee Creator", baseURL })
  const builder = await newPerson(browser, { role: "builder", name: "Waiting Builder", baseURL })
  await setUpPayouts(creator.page)

  const paidAt = new Date(Date.now() - 60_000)
  await insertPaidSale({ creatorUserId: creator.userId, builderUserId: builder.userId, paidAt })

  // In the hold period: on the page with its release date; nothing to pay yet.
  const page = creator.page
  await page.goto("/app/earnings")
  await expect(page.getByRole("heading", { level: 1, name: "Earnings" })).toBeVisible()
  await expect(page.getByText("In the hold period", { exact: true })).toBeVisible()
  await expect(page.getByText("€26.46").first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "Coming out of the hold" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Recent sales" })).toBeVisible()
  expect(await page.content()).not.toContain(SALE.buyerEmail)

  await runJob(page.request, "payouts-release", {
    now: new Date(paidAt.getTime() + DAY_MS),
    data: { runKey: `manual:${newId()}` },
  })
  expect(await transfersOf(creator.userId)).toEqual([])

  // Past the hold: one transfer of the creator's share; a second run pays nothing more.
  const afterHold = new Date(paidAt.getTime() + 15 * DAY_MS)
  await runJob(page.request, "payouts-release", {
    now: afterHold,
    data: { runKey: `manual:${newId()}` },
  })
  await runJob(page.request, "payouts-release", {
    now: new Date(afterHold.getTime() + 60_000),
    data: { runKey: `manual:${newId()}` },
  })
  const paid = await transfersOf(creator.userId)
  expect(paid).toHaveLength(1)
  expect(paid[0]).toMatchObject({ amount_cents: SALE.creatorCents, status: "created" })
  expect(paid[0]?.stripe_transfer_id).toMatch(/^tr_fake_/)
  // Not payouts-ready: the builder's share waits.
  expect(await transfersOf(builder.userId)).toEqual([])

  // The required "payout sent" email.
  await expect
    .poll(async () => (await latestEmailTo(creator.email))?.subject ?? "")
    .toBe("We sent you €26.46")

  await page.goto("/app/earnings/payouts")
  await expect(page.getByRole("heading", { level: 1, name: "Payouts" })).toBeVisible()
  const list = page.getByRole("list", { name: "Your payouts" })
  await expect(list.getByText("€26.46")).toBeVisible()
  await expect(list.getByText("Sent", { exact: true })).toBeVisible()

  // The earnings tabs (the sidebar has an "Overview" sub-item too).
  await page
    .getByRole("navigation", { name: "Earnings" })
    .getByRole("link", { name: "Overview" })
    .click()
  await expect(page).toHaveURL(/\/app\/earnings$/)
  await expect(page.getByText("Paid out", { exact: true })).toBeVisible()
  expect(await page.content()).not.toContain(SALE.buyerEmail)
})
