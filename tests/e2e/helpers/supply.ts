import type { Page } from "@playwright/test"

import { uniqueEmail } from "./accounts"
import { chooseRole, signUp } from "./auth"
import { completeOnboardingInDb, withE2eDb } from "./db"

/**
 * Ideas and products in the browser (CLAUDE.md §19.25): a signed-in, onboarded creator or builder,
 * and reads of what the pages wrote.
 */

/** Sign up, pick the role and finish onboarding in the database (the specs are about supply). */
export async function onboardedUser(
  page: Page,
  role: "creator" | "builder",
  label: string,
  name: string,
): Promise<string> {
  const email = uniqueEmail(label)
  await signUp(page, email, name)
  await chooseRole(page, role)
  await completeOnboardingInDb(email)
  return email
}

/** The events recorded about one idea or product (type and properties), oldest first. */
export async function eventsAbout(
  subjectId: string,
): Promise<{ type: string; properties: Record<string, unknown> }[]> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ type: string; properties: Record<string, unknown> }>(
      "SELECT type, properties FROM events WHERE subject_id = $1 ORDER BY occurred_at, id",
      [subjectId],
    )
    return rows
  })
}

/** Whether the embeddings job has embedded the row yet (it runs after the response). */
export async function embeddedAt(table: "ideas" | "products", id: string): Promise<string | null> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ embedded_at: Date | null }>(
      `SELECT embedded_at FROM ${table === "ideas" ? "ideas" : "products"} WHERE id = $1`,
      [id],
    )
    return rows[0]?.embedded_at?.toISOString() ?? null
  })
}

/** The id at the end of `/app/ideas/<id>` or `/app/products/<id>`. */
export function idFromUrl(url: string): string {
  const id = new URL(url).pathname.split("/").at(-1)
  if (!id) throw new Error(`no id in ${url}`)
  return id
}

/** How far the page scrolls sideways (0 or less: it doesn't). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement
    return root.scrollWidth - window.innerWidth
  })
}

/** Type topics into the tag input, one Enter each. */
export async function addTopics(page: Page, topics: string[]): Promise<void> {
  const field = page.getByLabel(/^Topics/)
  for (const topic of topics) {
    await field.fill(topic)
    await field.press("Enter")
  }
}
