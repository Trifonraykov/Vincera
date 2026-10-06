import { expect, test } from "./fixtures"
import { insertPaidOrder, memberEmails } from "./helpers/analytics"
import { signIn } from "./helpers/auth"
import { insertLiveKeyLaunch, sidewaysOverflow } from "./helpers/checkout"

/**
 * Phase 7 pages on a phone (`mobile` project; CLAUDE.md §19.20, §19.41): the tracked links page,
 * the collab analytics page and the buyer's refund request at 390 and 360 px: no sideways scroll
 * (wide tables scroll inside their own box), 44 px targets, 16 px fields.
 */

async function noSidewaysScroll(page: import("@playwright/test").Page) {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 740 })
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0)
  }
}

test("links and analytics fit a phone", async ({ page }) => {
  test.setTimeout(120_000)
  const launch = await insertLiveKeyLaunch("Phone links timer")
  await signIn(page, memberEmails(launch.slug).creator)

  await page.goto(`/app/launches/${launch.launchId}/links`)
  await expect(page.getByRole("heading", { name: "Default" })).toBeVisible()
  const add = page.getByRole("button", { name: "Add link" })
  expect((await add.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  const fontSize = await page
    .getByLabel("Name", { exact: true })
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(fontSize).toBeGreaterThanOrEqual(16)
  await noSidewaysScroll(page)

  await page.goto(`/app/collabs/${await collabOf(launch.launchId)}/analytics`)
  await expect(page.getByRole("heading", { name: "Funnel" })).toBeVisible()
  await noSidewaysScroll(page)
})

test("a buyer asks for a refund on a phone", async ({ page }) => {
  const launch = await insertLiveKeyLaunch("Phone refund timer")
  const { token } = await insertPaidOrder(launch.launchId)
  await page.goto(`/access/${token}/refund`)
  const submit = page.getByRole("button", { name: "Ask for a refund" })
  expect((await submit.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await noSidewaysScroll(page)
  await page.locator("label").filter({ hasText: "I bought it by mistake" }).click()
  await submit.click()
  // The action revalidates the page, which then shows the stored request instead of the form.
  await expect(page.getByText("Waiting for a decision")).toBeVisible()
})

async function collabOf(launchId: string): Promise<string> {
  const { withE2eDb } = await import("./helpers/db")
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ collab_id: string }>(
      "SELECT collab_id FROM launches WHERE id = $1",
      [launchId],
    )
    return rows[0]?.collab_id ?? ""
  })
}
