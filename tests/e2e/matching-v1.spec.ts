import { expect, test } from "./fixtures"
import { signedInAdmin } from "./helpers/launches"

/**
 * §16 Phase 7 acceptance, matching side (CLAUDE.md §19.42), on the desktop layout: the admin sees
 * funnel conversion by match-score bucket (from the seeded matching history), trains a v1 model
 * and sees it evaluated against v0 on held-out data. v1 stays inactive (activation is covered by
 * the integration tests: it starts a recompute for everyone, which would race other specs).
 */

test("the admin sees the score-bucket funnel and trains v1 against v0", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const admin = await signedInAdmin(browser, baseURL)
  await admin.goto("/admin/matching")
  await expect(admin.getByRole("heading", { level: 1, name: "Matching" })).toBeVisible()
  await expect(admin.getByTestId("ranking-version")).toHaveText("v0")

  // The funnel by match score: five buckets with shown matches and every later step.
  const funnel = admin.getByRole("table", { name: "Funnel by match score, v0" })
  await expect(funnel).toBeVisible()
  for (const label of ["0–20%", "20–40%", "40–60%", "60–80%", "80–100%"]) {
    await expect(funnel.getByRole("rowheader", { name: label })).toBeVisible()
  }
  for (const column of ["Shown", "Proposal sent", "Accepted", "Launch live", "≥ 1 sale"]) {
    await expect(funnel.getByRole("columnheader", { name: column, exact: true })).toBeVisible()
  }
  const total = funnel.getByRole("row", { name: /^All/ })
  await expect(total).toBeVisible()
  const shown = Number((await total.getByRole("cell").first().innerText()).replace(/\D/g, ""))
  expect(shown).toBeGreaterThanOrEqual(600)

  // Train: a new inactive version, compared with v0 on the hold-out.
  await admin.getByRole("button", { name: "Train a v1 model" }).first().click()
  await expect(admin.getByText(/Trained v1-\d{4}-\d{2}-\d{2}/)).toBeVisible({ timeout: 30_000 })
  const comparison = admin.locator("#comparison")
  await expect(
    comparison.getByRole("heading", { name: /^v1-\d{4}-\d{2}-\d{2}(-\d+)? against v0$/ }),
  ).toBeVisible()
  const accepted = comparison.locator('[data-target="accepted"]')
  await expect(accepted.locator('[data-metric="auc-v1"]')).toHaveText(/^0\.\d{3}/)
  await expect(accepted.locator('[data-metric="auc-v0"]')).toHaveText(/^0\.\d{3}/)
  await expect(admin.getByRole("heading", { name: "Calibration by decile" })).toBeVisible()
  await expect(admin.getByText("Not much data yet")).toBeVisible()
  // Still ranking with v0: the new version is stored inactive.
  await expect(admin.getByTestId("ranking-version")).toHaveText("v0")
  await expect(admin.getByRole("button", { name: /^Activate v1-/ }).first()).toBeVisible()

  await admin.context().close()
})
