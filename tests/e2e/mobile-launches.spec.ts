import { devices, type Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { insertBuildingCollab, launchState, signedInAdmin } from "./helpers/launches"
import { horizontalOverflow, newPerson } from "./helpers/proposals"

/**
 * Launches on a phone ("mobile" project, iPhone 13; CLAUDE.md §19.20, §19.32): the setup form's
 * 16 px fields and its Save bar above the tab bar, 44 px actions, the launches list and the
 * public product page without sideways scrolling at 390 and 360 px, and the admin queue.
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

test("set up, approve and open a launch on a phone", async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const phone = { ...PHONE, colorScheme: "dark" as const }
  const creator = await newPerson(browser, {
    role: "creator",
    name: "Pia Phone",
    baseURL,
    contextOptions: phone,
  })
  const builder = await newPerson(browser, {
    role: "builder",
    name: "Bo Phone",
    baseURL,
    contextOptions: phone,
  })
  const collabId = await insertBuildingCollab(creator.userId, builder.userId, "Pocket budget")
  const c = creator.page

  await c.goto(`/app/collabs/${collabId}/launch`)
  const start = c.getByRole("button", { name: "Set up the launch" })
  expect((await start.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await start.click()
  const price = c.getByLabel("Price")
  await expect(price).toBeVisible()
  expect(
    await price.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16)
  await price.fill("9")
  await c.getByLabel("Page address").fill(`pocket-budget-${Date.now().toString(36)}`)
  await c.locator("label").filter({ hasText: "A link" }).click()
  await c.getByLabel("Link buyers are sent to").fill("https://budget.example.com")

  // The Save bar sits above the tab bar.
  const save = c.getByRole("button", { name: "Save launch" })
  const tabs = c.getByRole("navigation", { name: "Main" })
  const [saveBox, tabsBox] = [await save.boundingBox(), await tabs.boundingBox()]
  expect(saveBox && tabsBox && saveBox.y + saveBox.height <= tabsBox.y + 1).toBe(true)
  await save.click()
  await expect(c.getByText("Saved.", { exact: true })).toBeVisible()
  await fitsPhone(c, "/app/collabs/[id]/launch")

  for (const person of [creator, builder]) {
    await person.page.goto(`/app/collabs/${collabId}/launch`)
    await person.page.getByRole("button", { name: "Approve this version" }).click()
    await expect(person.page.getByRole("button", { name: "Approve this version" })).toHaveCount(0)
  }
  expect(await launchState(collabId)).toMatchObject({ status: "admin_review" })

  const admin = await signedInAdmin(browser, baseURL, phone)
  await admin.goto("/admin/launches")
  await fitsPhone(admin, "/admin/launches")
  const card = admin.getByRole("article", { name: "Pocket budget" })
  await card.getByRole("button", { name: "Approve and go live" }).click()
  await expect(card).toHaveCount(0)
  const state = await launchState(collabId)

  // The launches list (from Me when it is not a tab) and the public page.
  await c.goto("/app/launches")
  await expect(c.getByRole("link", { name: /Pocket budget/ })).toBeVisible()
  await fitsPhone(c, "/app/launches")
  await c.goto(`/p/${state?.slug}`)
  await expect(c.getByRole("button", { name: "Buy for €9.00" })).toBeVisible()
  expect(
    (await c.getByRole("button", { name: "Buy for €9.00" }).boundingBox())?.height,
  ).toBeGreaterThanOrEqual(44)
  await fitsPhone(c, "/p/[slug]")

  for (const page of [c, builder.page, admin]) await page.context().close()
})
