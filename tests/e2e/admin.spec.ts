import { newId } from "@/lib/ids"

import { expect, test } from "./fixtures"
import { withE2eDb } from "./helpers/db"
import { signedInAdmin } from "./helpers/launches"
import { insertPaidSale } from "./helpers/payouts"
import { newPerson } from "./helpers/proposals"

/**
 * §16 Phase 6 acceptance: "Admin can resolve a dispute and make an audited ledger adjustment"
 * (CLAUDE.md §19.38–§19.39). A collab with a paid, posted sale and a dispute the creator raised
 * (written to the database; raising is the trust area's spec). The admin takes it into review,
 * resolves it with a ledger adjustment (−€5 creator, +€5 builder on the order), and the audit log
 * shows both actions. The adjustment's entries sum to zero.
 */

test("an admin resolves a dispute with an audited ledger adjustment", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const creator = await newPerson(browser, { role: "creator", name: "Dana Creator", baseURL })
  const builder = await newPerson(browser, { role: "builder", name: "Bo Builder", baseURL })
  const { orderId, launchId } = await insertPaidSale({
    creatorUserId: creator.userId,
    builderUserId: builder.userId,
    paidAt: new Date(Date.now() - 60_000),
  })
  const disputeId = newId()
  await withE2eDb((pool) =>
    pool.query(
      `INSERT INTO disputes (id, collab_id, raised_by_user_id, kind, description)
       SELECT $1, l.collab_id, $2, 'split', 'The builder did most of the extra work.'
       FROM launches l WHERE l.id = $3`,
      [disputeId, creator.userId, launchId],
    ),
  )

  const admin = await signedInAdmin(browser, baseURL)
  await admin.goto("/admin/disputes")
  await expect(admin.getByRole("heading", { level: 1, name: "Disputes" })).toBeVisible()
  await admin
    .getByRole("link", { name: /Budget planner/ })
    .first()
    .click()
  await expect(admin).toHaveURL(new RegExp(`/admin/disputes/${disputeId}$`))
  await expect(admin.getByText("The builder did most of the extra work.")).toBeVisible()

  // Open → in review.
  await admin.getByRole("button", { name: "Take into review" }).click()
  await expect(admin.getByRole("heading", { name: "Resolve" })).toBeVisible()

  // Resolve with a ledger adjustment on the order.
  await admin.getByRole("radio", { name: "Ledger adjustment" }).check()
  await admin.getByLabel("Order (optional)").selectOption(orderId)
  await admin.getByLabel("Line 1: who").selectOption(creator.userId)
  await admin.getByLabel("Amount (€)").nth(0).fill("-5")
  await admin.getByLabel("Line 2: who").selectOption(builder.userId)
  await admin.getByLabel("Amount (€)").nth(1).fill("5")
  await expect(admin.getByText("€0.00 · balanced")).toBeVisible()
  await admin.getByLabel("Reason for the adjustment (audit log)").fill("Extra build work")
  await admin.getByLabel("Note to the members").fill("We moved €5 of the creator's share.")
  await admin.getByRole("button", { name: "Resolve the dispute" }).click()

  await expect(admin.getByRole("heading", { name: "Resolution" })).toBeVisible()
  await expect(admin.getByText("We moved €5 of the creator's share.")).toBeVisible()
  await expect(admin.getByText("Extra build work")).toBeVisible()

  // The money: two adjustment entries summing to zero, on the order.
  const entries = await withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ user_id: string; amount_cents: number }>(
      `SELECT e.user_id, e.amount_cents FROM ledger_entries e
       JOIN ledger_adjustments a ON a.id = e.adjustment_id
       WHERE a.dispute_id = $1 AND e.order_id = $2`,
      [disputeId, orderId],
    )
    return rows
  })
  expect(entries).toHaveLength(2)
  expect(entries.reduce((total, row) => total + row.amount_cents, 0)).toBe(0)
  expect(entries.find((row) => row.user_id === creator.userId)?.amount_cents).toBe(-500)

  // The audit log shows both decisions.
  await admin.goto("/admin/audit")
  // The entries, not the action filter's options of the same names.
  const audit = admin.getByRole("list", { name: "Audit entries" })
  await expect(audit.getByText("Made a ledger adjustment").first()).toBeVisible()
  await expect(audit.getByText("Resolved a dispute").first()).toBeVisible()
  await expect(audit.getByText("Took a dispute into review").first()).toBeVisible()

  // The members were told.
  await creator.page.goto("/app/notifications")
  await expect(creator.page.getByText(/resolved/i).first()).toBeVisible()

  for (const page of [creator.page, builder.page, admin]) await page.context().close()
})
