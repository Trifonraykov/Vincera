import { expect, type Locator, type Page } from "@playwright/test"

import { signIn } from "./auth"

/**
 * Discover helpers (CLAUDE.md §19.27). Specs sign in as people `pnpm db:seed` created (the e2e
 * global setup seeds before every run): their matches are computed by the real recompute, with
 * explanations from the fake AI. The collab seed uses creators/builders 01–03, so Discover specs
 * use 05 and up, one person per spec, and never depend on a fixed card: earlier tests (or a retry)
 * may have saved or dismissed some.
 */

export function seededCreator(n: number): string {
  return `seed-creator-${String(n).padStart(2, "0")}@example.com`
}

export function seededBuilder(n: number): string {
  return `seed-builder-${String(n).padStart(2, "0")}@example.com`
}

/** Sign in as a seeded person and land in the app. */
export async function signInSeeded(page: Page, email: string): Promise<void> {
  await signIn(page, email)
  await expect(page).toHaveURL(/\/app(\/|$|\?)/)
}

/** The cards (list items) of a ranked list. */
export function matchCards(page: Page, listLabel: string): Locator {
  return page
    .getByRole("list", { name: listLabel })
    .getByRole("listitem")
    .filter({
      has: page.getByLabel(/% match/),
    })
}

/** "82%" badges of the cards, as numbers, in page order. */
export async function cardScores(cards: Locator): Promise<number[]> {
  const labels = await cards.getByLabel(/% match/).allInnerTexts()
  return labels.map((text) => Number.parseInt(text, 10))
}

/** A card's accessible name ("Product: Pantry Planner"). */
export async function cardName(card: Locator): Promise<string> {
  const name = await card.getAttribute("aria-label")
  if (!name) throw new Error("match card without a name")
  return name
}

/** The card's title (its name without the "Product: " prefix). */
export function cardTitle(name: string): string {
  return name.slice(name.indexOf(": ") + 2)
}

/** Sideways overflow of the page (≤ 0: none). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement
    return root.scrollWidth - window.innerWidth
  })
}
