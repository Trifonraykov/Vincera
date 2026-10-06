import { devices, type Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import {
  horizontalOverflow,
  insertOpenIdea,
  newPerson,
  proposalIdFrom,
  proposalState,
} from "./helpers/proposals"

/**
 * Proposals, the inbox and notifications on a phone ("mobile" project, iPhone 13 on Chromium;
 * CLAUDE.md §19.20, §19.26): the proposal form with its sticky Send bar, the Inbox tab's badge,
 * the notifications list, the answer buttons in the sticky bar above the tab bar, the counter-offer
 * as a bottom sheet, and no page scrolling sideways at 360 and 390 px.
 */

// The phone's screen, touch and user agent for the extra browser contexts (the browser itself is
// the project's Chromium, so the device's default browser type is left out).
const { defaultBrowserType: _browserType, ...PHONE } = devices["iPhone 13"]

async function expectFitsPhone(page: Page, label: string) {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: PHONE.viewport.height })
    expect(await horizontalOverflow(page), `${label} at ${width}px`).toBeLessThanOrEqual(0)
  }
  await page.setViewportSize(PHONE.viewport)
}

/** The button is on screen, above the tab bar, and at least 44 px tall. */
async function expectAboveTabBar(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true })
  await expect(button).toBeInViewport()
  const tabs = await page.getByRole("navigation", { name: "Main" }).boundingBox()
  const box = await button.boundingBox()
  expect(box && tabs && box.y + box.height).toBeLessThanOrEqual(tabs?.y ?? 0)
  expect(box?.height).toBeGreaterThanOrEqual(44)
}

test("a proposal goes back and forth on phones", async ({ browser, baseURL }) => {
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
  const ideaId = await insertOpenIdea(creator.userId, "Plant care reminders")

  // The builder writes the proposal: Send stays in reach at the bottom of the screen.
  const b = builder.page
  await b.goto(`/app/proposals/new?to=${creator.userId}&idea=${ideaId}`)
  await expect(b.getByRole("heading", { level: 1, name: "Send a proposal" })).toBeVisible()
  await expect(b.locator("[data-app-bar]")).toContainText("New proposal")
  await expectFitsPhone(b, "/app/proposals/new")
  // By role, which skips hidden copies: Next may keep a hidden instance of the page mounted while
  // it hydrates (a flaky strict-mode failure under `next start`, CLAUDE.md §19.30).
  const scope = b.getByRole("textbox", { name: "What you'll build together" })
  expect(
    await scope.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(16)
  await scope.fill("A reminders app with plant profiles.")
  await b.getByLabel("Creator's share").fill("60")
  await expect(b.getByLabel("Builder %")).toHaveValue("40")
  await expectAboveTabBar(b, "Send proposal")
  await b.getByRole("button", { name: "Send proposal" }).click()
  await expect(b).toHaveURL(/\/app\/proposals\/[0-9a-f-]{36}\?sent=1$/)
  const proposalId = proposalIdFrom(b.url())
  await expectAboveTabBar(b, "Withdraw proposal")
  await expectFitsPhone(b, "/app/proposals/[id] (sender)")

  // The creator: the Inbox tab counts the new notification; the list leads to the proposal.
  const c = creator.page
  await c.goto("/app")
  const tabs = c.getByRole("navigation", { name: "Main" })
  await expect(tabs.getByRole("link", { name: "Inbox (1 unread)" })).toBeVisible()
  await tabs.getByRole("link", { name: "Inbox (1 unread)" }).click()
  await expect(c).toHaveURL(/\/app\/messages$/)
  await expect(c.getByRole("heading", { level: 1, name: "Messages" })).toBeVisible()
  await expectFitsPhone(c, "/app/messages")
  await c
    .getByRole("link", { name: /^Notifications/ })
    .first()
    .click()
  await expect(c).toHaveURL(/\/app\/notifications$/)
  await expectFitsPhone(c, "/app/notifications")
  // Still on the Inbox tab.
  await expect(tabs.getByRole("link", { name: /^Inbox/ })).toHaveAttribute("aria-current", "true")
  await c.getByRole("button", { name: /Max Mobile sent you a proposal/ }).click()
  await expect(c).toHaveURL(new RegExp(`/app/proposals/${proposalId}$`))
  await expectFitsPhone(c, "/app/proposals/[id] (recipient)")

  // Accept, Counter and Decline sit in the sticky bar above the tab bar.
  await expectAboveTabBar(c, "Accept")
  await expectAboveTabBar(c, "Counter")
  await c.getByRole("button", { name: "Counter", exact: true }).click()
  const sheet = c.getByRole("dialog", { name: "Your counter-offer" })
  await expect(sheet).toBeVisible()
  // A bottom sheet: it ends at the bottom edge of the screen (once its slide-in has finished).
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox()
      return Math.round((box?.y ?? 0) + (box?.height ?? 0))
    })
    .toBe(PHONE.viewport.height)
  await sheet.getByLabel("Creator %").fill("70")
  await sheet.getByRole("button", { name: "Send counter-offer" }).click()
  await expect(sheet).toBeHidden()
  await expect(c.getByText("Countered").first()).toBeVisible()
  await expectAboveTabBar(c, "Withdraw proposal")

  // The builder accepts from the sticky bar.
  await b.goto(`/app/proposals/${proposalId}`)
  // The change is marked in the offer history (the terms card can repeat it).
  const history = b.getByRole("list", { name: "Offers, newest first" })
  await expect(history.getByText("was 60% / 40%")).toBeVisible()
  await expectAboveTabBar(b, "Accept")
  await b.getByRole("button", { name: "Accept", exact: true }).click()
  await b.getByRole("button", { name: "Accept and start the collab" }).click()
  await expect(b.getByText("Accepted: you're collaborating")).toBeVisible()
  await expect(b.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0)
  await expectFitsPhone(b, "/app/proposals/[id] (accepted)")
  expect(await proposalState(proposalId)).toMatchObject({
    status: "accepted",
    creator_split: 70,
    builder_split: 30,
  })

  // The proposals list on a phone.
  await b.goto("/app/proposals?tab=closed")
  await expect(b.getByRole("link", { name: /Plant care reminders/ })).toBeVisible()
  await expectFitsPhone(b, "/app/proposals")

  await creator.page.context().close()
  await builder.page.context().close()
})
