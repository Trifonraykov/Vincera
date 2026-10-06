import { expect, test } from "./fixtures"
import {
  cardName,
  cardTitle,
  horizontalOverflow,
  matchCards,
  seededBuilder,
  seededCreator,
  signInSeeded,
} from "./helpers/discover"

/**
 * Discover on a phone ("mobile" project, iPhone 13; CLAUDE.md §19.20, §19.27): the Discover tab,
 * the Discover sub-tabs as a sideways-scrolling row of 44 px links, match cards with 44 px Save /
 * Dismiss / "Send a proposal", nothing behind hover, and no sideways page scroll at 390 and 360 px.
 */

test.use({ colorScheme: "dark" })

async function expectNoSidewaysScroll(page: import("@playwright/test").Page) {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 740 })
    expect(await horizontalOverflow(page), `sideways scroll at ${width}px`).toBeLessThanOrEqual(0)
  }
  await page.setViewportSize({ width: 390, height: 664 })
}

test("a creator works through matches on a phone", async ({ page }) => {
  test.setTimeout(120_000)
  await signInSeeded(page, seededCreator(6))
  await page.goto("/app")

  // Creators have the Feed in Discover's tab slot (CLAUDE.md §19.45); Discover is on Me.
  const tabs = page.getByRole("navigation", { name: "Main" })
  await expect(tabs.getByRole("link", { exact: true, name: "Feed" })).toBeVisible()
  await tabs.getByRole("link", { exact: true, name: "Me" }).click()
  await page
    .getByRole("link", { name: /^Discover/ })
    .first()
    .click()
  await expect(page).toHaveURL(/\/app\/discover$/)
  await expect(page.locator("[data-app-bar]")).toContainText("Discover")

  const cards = matchCards(page, "Your matches")
  await expect(cards.nth(1)).toBeVisible()
  await expectNoSidewaysScroll(page)

  // Discover's own tabs: 44 px links.
  const subTabs = page.getByRole("navigation", { name: "Discover" }).getByRole("link")
  for (const link of await subTabs.all()) {
    expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  }

  // Card actions are 44 px tall on a touch screen.
  const first = cards.first()
  const title = cardTitle(await cardName(first))
  for (const name of [`Save ${title}`, `Dismiss ${title}`]) {
    expect(
      (await first.getByRole("button", { name }).boundingBox())?.height,
    ).toBeGreaterThanOrEqual(44)
  }
  const propose = first.getByRole("link", { name: "Send a proposal" })
  await expect(propose).toBeVisible()
  expect((await propose.boundingBox())?.height).toBeGreaterThanOrEqual(44)

  // "Why this match" opens with a tap (no hover).
  await first.getByText("Why this match", { exact: true }).tap()
  await expect(first.getByText("Shared topics", { exact: true })).toBeVisible()

  // Save, dismiss another, reload: both stick.
  await first.getByRole("button", { name: `Save ${title}` }).tap()
  await expect(
    first.getByRole("button", { name: `Saved: ${title}. Remove from saved` }),
  ).toBeVisible()
  const dismissedName = await cardName(cards.nth(1))
  await cards
    .nth(1)
    .getByRole("button", { name: `Dismiss ${cardTitle(dismissedName)}` })
    .tap()
  await expect(page.getByRole("listitem", { name: dismissedName, exact: true })).toHaveCount(0)
  await page.reload()
  await expect(cards.first()).toBeVisible()
  await expect(page.getByRole("listitem", { name: dismissedName, exact: true })).toHaveCount(0)

  await page
    .getByRole("navigation", { name: "Discover" })
    .getByRole("link", { name: "Saved" })
    .tap()
  await expect(page).toHaveURL(/\/app\/discover\/saved$/)
  // At least this one (a CI retry may have saved another before).
  await expect(
    page.getByRole("list", { name: "Saved matches" }).getByRole("listitem", { name: title }),
  ).not.toHaveCount(0)
  await expectNoSidewaysScroll(page)
})

test("a builder reads briefs on a phone", async ({ page }) => {
  test.setTimeout(90_000)
  await signInSeeded(page, seededBuilder(6))
  await page.goto("/app/discover/briefs")
  await expect(page.getByRole("heading", { level: 1, name: "Briefs" })).toBeVisible()
  await expect(matchCards(page, "Briefs matched to you").first()).toBeVisible()
  await expectNoSidewaysScroll(page)
  await page.goto("/app/discover/creators")
  await expect(page.getByLabel(/% match/).first()).toBeVisible()
  await expectNoSidewaysScroll(page)
})
