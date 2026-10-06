import { expect, test } from "./fixtures"
import {
  cardName,
  cardScores,
  cardTitle,
  matchCards,
  seededBuilder,
  seededCreator,
  signInSeeded,
} from "./helpers/discover"

/**
 * Discover on desktop (§16 Phase 2 acceptance; CLAUDE.md §19.27): a seeded person sees ranked
 * matches with a score and an explanation each; Save and Dismiss persist across a reload; opening
 * a card leads to its page; "Send a proposal" carries the match; builders see briefs and creators;
 * the home page shows top matches.
 */

test("a seeded creator sees ranked, explained matches; save and dismiss persist", async ({
  page,
}) => {
  test.setTimeout(120_000)
  await signInSeeded(page, seededCreator(5))

  // Home: the role's widgets, including top matches.
  await page.goto("/app")
  await expect(page.getByRole("heading", { level: 2, name: /Top matches/ })).toBeVisible()
  await expect(matchCards(page, "Your top matches").first()).toBeVisible()

  await page.goto("/app/discover")
  await expect(page.getByRole("heading", { level: 1, name: "Discover" })).toBeVisible()
  const cards = matchCards(page, "Your matches")
  await expect(cards.nth(2)).toBeVisible()
  const scores = await cardScores(cards)
  expect(scores.length).toBeGreaterThanOrEqual(3)
  expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  // Every card explains itself in one plain sentence (no numbers) and offers a proposal.
  for (const card of await cards.all()) {
    const sentence = await card.locator("p").first().innerText()
    expect(sentence).toMatch(/^[A-Z].{20,}\.$/)
    expect(sentence).not.toMatch(/\d/)
  }
  const proposal = cards.first().getByRole("link", { name: "Send a proposal" })
  await expect(proposal).toHaveAttribute("href", /^\/app\/proposals\/new\?to=[^&]+&.*match=/)

  // Save the first card.
  const first = cards.first()
  const savedName = await cardName(first)
  const savedTitle = cardTitle(savedName)
  await first.getByRole("button", { name: `Save ${savedTitle}` }).click()
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible()
  // Dismiss the second card.
  const dismissedName = await cardName(cards.nth(1))
  await cards
    .nth(1)
    .getByRole("button", { name: `Dismiss ${cardTitle(dismissedName)}` })
    .click()
  await expect(page.getByRole("listitem", { name: dismissedName, exact: true })).toHaveCount(0)

  // Both persist across a reload.
  await page.reload()
  await expect(cards.first()).toBeVisible()
  const savedCard = page.getByRole("listitem", { name: savedName, exact: true })
  await expect(
    savedCard.getByRole("button", { name: `Saved: ${savedTitle}. Remove from saved` }),
  ).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("listitem", { name: dismissedName, exact: true })).toHaveCount(0)

  // Saved lists it.
  await page
    .getByRole("navigation", { name: "Discover" })
    .getByRole("link", { name: "Saved" })
    .click()
  await expect(page).toHaveURL(/\/app\/discover\/saved$/)
  await expect(
    page.getByRole("list", { name: "Saved matches" }).getByRole("listitem", { name: savedName }),
  ).toBeVisible()

  // Builders only: the creator's Builders tab lists builder matches.
  await page
    .getByRole("navigation", { name: "Discover" })
    .getByRole("link", { name: "Builders" })
    .click()
  await expect(page).toHaveURL(/\/app\/discover\/builders$/)
  const builderCards = page
    .getByRole("main")
    .getByRole("listitem")
    .filter({
      has: page.getByLabel(/% match/),
    })
  await expect(builderCards.first()).toBeVisible()
  for (const name of await builderCards.evaluateAll((items) =>
    items.map((item) => item.getAttribute("aria-label") ?? ""),
  )) {
    expect(name).toMatch(/^Builder: /)
  }

  // Opening a card goes to its page.
  await page.goto("/app/discover")
  await cards
    .first()
    .getByRole("button", { name: /^Open / })
    .click()
  await expect(page).toHaveURL(/\/(app\/products\/[0-9a-f-]+|b\/[a-z0-9_]+)$/)
})

test("a seeded builder sees briefs and creators matched to them", async ({ page }) => {
  test.setTimeout(90_000)
  await signInSeeded(page, seededBuilder(5))

  await page.goto("/app/discover")
  const cards = matchCards(page, "Your matches")
  await expect(cards.first()).toBeVisible()
  const names = await cards.evaluateAll((items) =>
    items.map((item) => item.getAttribute("aria-label") ?? ""),
  )
  expect(names.every((name) => /^(Brief|Creator): /.test(name))).toBe(true)

  await page
    .getByRole("navigation", { name: "Discover" })
    .getByRole("link", { name: "Briefs" })
    .click()
  await expect(page).toHaveURL(/\/app\/discover\/briefs$/)
  const briefs = matchCards(page, "Briefs matched to you")
  await expect(briefs.first()).toBeVisible()
  await expect(briefs.first().getByRole("link", { name: "Send a proposal" })).toHaveAttribute(
    "href",
    /[?&]idea=[0-9a-f-]+/,
  )

  await page
    .getByRole("navigation", { name: "Discover" })
    .getByRole("link", { name: "Creators" })
    .click()
  await expect(page).toHaveURL(/\/app\/discover\/creators$/)
  await expect(page.getByLabel(/% match/).first()).toBeVisible()
})
