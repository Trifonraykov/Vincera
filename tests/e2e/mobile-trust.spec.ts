import { expect, test } from "./fixtures"
import { acceptAndOpenCollab, sendPitch } from "./helpers/collabs"
import { horizontalOverflow, insertOpenIdea, newPerson } from "./helpers/proposals"

/**
 * Phase 6 trust on a phone (CLAUDE.md §19.40): the account page's data tools fit at 360 px with
 * 44 px buttons, and "Raise a dispute" opens a bottom sheet whose submit stays on screen.
 */

test("account data tools and the dispute sheet on a phone", async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const phone = { viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true }
  const creator = await newPerson(browser, {
    role: "creator",
    name: "Ada Phone",
    baseURL,
    contextOptions: phone,
  })
  const builder = await newPerson(browser, { role: "builder", name: "Bo Phone", baseURL })
  const page = creator.page

  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 664 })
    await page.goto("/app/settings/account")
    const exportLink = page.getByRole("link", { name: "Export my data" })
    await expect(exportLink).toBeVisible()
    expect((await exportLink.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
  }

  const ideaId = await insertOpenIdea(creator.userId, "Pocket budget")
  const proposalId = await sendPitch(builder, creator, ideaId)
  await acceptAndOpenCollab(creator, proposalId)
  await page.getByRole("button", { name: "Raise a dispute" }).click()
  const sheet = page.getByRole("dialog", { name: "Raise a dispute" })
  await expect(sheet).toBeVisible()
  const box = await sheet.boundingBox()
  expect(box?.y ?? 0).toBeGreaterThan(0)
  const submit = sheet.getByRole("button", { name: "Raise the dispute" })
  await submit.scrollIntoViewIfNeeded()
  await expect(submit).toBeInViewport()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
})
