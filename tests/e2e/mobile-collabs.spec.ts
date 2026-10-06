import { devices, type Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { acceptAndOpenCollab, sendPitch } from "./helpers/collabs"
import { horizontalOverflow, insertOpenIdea, newPerson } from "./helpers/proposals"

/**
 * Collabs on a phone ("mobile" project, iPhone 13 on Chromium; CLAUDE.md §19.20, §19.28): the
 * Collabs tab, the section links, the agreement's Sign bar above the tab bar, the payouts notice,
 * the app bar's "New task" opening a bottom sheet with 16 px fields, 44 px task controls, and no
 * page scrolling sideways at 360 and 390 px.
 */

const { defaultBrowserType: _browserType, ...PHONE } = devices["iPhone 13"]

async function expectFitsPhone(page: Page, label: string) {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: PHONE.viewport.height })
    expect(await horizontalOverflow(page), `${label} at ${width}px`).toBeLessThanOrEqual(0)
  }
  await page.setViewportSize(PHONE.viewport)
}

/** The control is on screen, above the tab bar, and at least 44 px tall. */
async function expectAboveTabBar(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true })
  // A sticky bar sticks once its form is on screen (it cannot rise above the form's top), so
  // bring the start of the form into view first, as a person scrolling down to it would.
  await button.evaluate((element) => {
    element.closest("form")?.scrollIntoView({ block: "start" })
  })
  await expect(button).toBeInViewport()
  const tabs = await page.getByRole("navigation", { name: "Main" }).boundingBox()
  const box = await button.boundingBox()
  expect(box && tabs && box.y + box.height).toBeLessThanOrEqual(tabs?.y ?? 0)
  expect(box?.height).toBeGreaterThanOrEqual(44)
}

test("a collab works on phones", async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const phone = { contextOptions: PHONE }
  const creator = await newPerson(browser, {
    role: "creator",
    name: "Pia Phone",
    baseURL,
    ...phone,
  })
  const builder = await newPerson(browser, {
    role: "builder",
    name: "Max Mobile",
    baseURL,
    ...phone,
  })
  const ideaId = await insertOpenIdea(creator.userId, "Plant watering planner")
  const proposalId = await sendPitch(builder, creator, ideaId)
  const collabId = await acceptAndOpenCollab(creator, proposalId)
  const c = creator.page

  // The overview: the app bar names the page, the section links are 44 px and scroll in place.
  await expect(c.locator("[data-app-bar]")).toContainText("Collab")
  const sections = c.getByRole("navigation", { name: "Collab sections" })
  for (const name of ["Overview", "Agreement", "Tasks", "Messages"]) {
    const box = await sections.getByRole("link", { name }).boundingBox()
    expect(box?.height, name).toBeGreaterThanOrEqual(44)
  }
  await expectFitsPhone(c, "/app/collabs/[id]")

  // The Collabs tab lists it, waiting for the creator's signature.
  const tabs = c.getByRole("navigation", { name: "Main" })
  await tabs.getByRole("link", { name: "Collabs" }).click()
  await expect(c).toHaveURL(/\/app\/collabs$/)
  await expect(tabs.getByRole("link", { name: "Collabs" })).toHaveAttribute("aria-current", "page")
  const row = c.getByRole("link", { name: /Plant watering planner/ })
  await expect(row).toContainText("Your turn")
  await expectFitsPhone(c, "/app/collabs")

  // The agreement: the Sign bar stays above the tab bar while the text scrolls; payouts first.
  await row.click()
  await expect(c).toHaveURL(new RegExp(`/app/collabs/${collabId}/agreement$`))
  await expect(c.locator("[data-app-bar]")).toContainText("Agreement")
  await expect(c.getByText("Set up payouts before you sign")).toBeVisible()
  await expectAboveTabBar(c, "Sign the agreement")
  await expect(c.getByRole("button", { name: "Sign the agreement" })).toBeDisabled()
  const name = c.getByLabel("Type your full name to sign")
  expect(
    await name.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(16)
  await expectFitsPhone(c, "/app/collabs/[id]/agreement")

  // Tasks: "New task" is the app bar's action and opens a bottom sheet.
  await sections.getByRole("link", { name: "Tasks" }).click()
  await expect(c).toHaveURL(new RegExp(`/app/collabs/${collabId}/tasks$`))
  await c.locator("[data-app-bar]").getByRole("button", { name: "New task" }).click()
  const sheet = c.getByRole("dialog", { name: "New task" })
  await expect(sheet).toBeVisible()
  // A bottom sheet: it ends at the bottom edge of the screen once its slide-in has finished.
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox()
      return Math.round((box?.y ?? 0) + (box?.height ?? 0))
    })
    .toBe(PHONE.viewport.height)
  const title = sheet.getByLabel("Task", { exact: true })
  expect(
    await title.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(16)
  await title.fill("Photograph ten plants")
  await sheet.getByRole("button", { name: "Add task" }).click()
  await expect(sheet).toBeHidden()
  await expect(c.getByText("Photograph ten plants")).toBeVisible()
  const options = await c
    .getByRole("button", { name: "Options for “Photograph ten plants”" })
    .boundingBox()
  expect(options?.height).toBeGreaterThanOrEqual(44)
  await c.getByRole("button", { name: "Options for “Photograph ten plants”" }).click()
  await expect(c.getByRole("menuitem", { name: "Edit" })).toBeVisible()
  await c.keyboard.press("Escape")
  await expectFitsPhone(c, "/app/collabs/[id]/tasks")

  // Messages: the collab's thread fits the phone too.
  await sections.getByRole("link", { name: "Messages" }).click()
  await expect(c).toHaveURL(new RegExp(`/app/collabs/${collabId}/messages$`))
  await expect(c.getByRole("textbox", { name: "Message" })).toBeVisible()
  await expectFitsPhone(c, "/app/collabs/[id]/messages")

  await creator.page.context().close()
  await builder.page.context().close()
})
