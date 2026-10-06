import { randomBytes } from "node:crypto"

import { expect, type Browser, type BrowserContextOptions, type Page } from "@playwright/test"

import { listOutbox } from "@/lib/email/outbox"
import { newId } from "@/lib/ids"

import { uniqueEmail } from "./accounts"
import { chooseRole, signUp } from "./auth"
import { completeOnboardingInDb, withE2eDb } from "./db"

/**
 * Proposals, messages and notifications in the browser (CLAUDE.md §19.26): two people in two
 * browser contexts (each its own client IP, like `tests/e2e/fixtures.ts`), an open idea set up in
 * the database (ideas are supply's pages), and reads of what the pages wrote.
 */

export type Person = { page: Page; email: string; userId: string; name: string }

/**
 * A new person in their own browser context: signed up through the pages, role chosen, onboarding
 * finished in the database (the specs are about proposals).
 */
export async function newPerson(
  browser: Browser,
  options: {
    role: "creator" | "builder"
    name: string
    baseURL: string
    contextOptions?: BrowserContextOptions
  },
): Promise<Person> {
  const [a, b] = [randomBytes(2).toString("hex"), randomBytes(2).toString("hex")]
  const context = await browser.newContext({
    ...options.contextOptions,
    baseURL: options.baseURL,
    extraHTTPHeaders: { "x-forwarded-for": `2001:db8::${a}:${b}` },
  })
  const page = await context.newPage()
  const email = uniqueEmail(options.role)
  await signUp(page, email, options.name)
  await chooseRole(page, options.role)
  await completeOnboardingInDb(email)
  return { page, email, userId: await userIdOf(email), name: options.name }
}

export async function userIdOf(email: string): Promise<string> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
      email.toLowerCase(),
    ])
    const id = rows[0]?.id
    if (!id) throw new Error(`no user with email ${email}`)
    return id
  })
}

/** An open (published) idea of the creator, as the supply pages would leave it. */
export async function insertOpenIdea(creatorUserId: string, title: string): Promise<string> {
  return withE2eDb(async (pool) => {
    const id = newId()
    const { rowCount } = await pool.query(
      `INSERT INTO ideas (id, creator_profile_id, title, problem, format, status, published_at)
       SELECT $1, cp.id, $2, 'Students waste food and money planning meals.', 'app', 'open', now()
       FROM creator_profiles cp WHERE cp.user_id = $3`,
      [id, title, creatorUserId],
    )
    if (rowCount !== 1) throw new Error("insertOpenIdea: no creator profile")
    return id
  })
}

export type ProposalRow = {
  status: string
  revisions: number
  collab_id: string | null
  creator_split: number | null
  builder_split: number | null
  idea_status: string | null
}

/** The proposal as stored, with its revision count and the collab it became. */
export async function proposalState(proposalId: string): Promise<ProposalRow | null> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<ProposalRow>(
      `SELECT p.status,
              (SELECT count(*)::int FROM proposal_revisions r WHERE r.proposal_id = p.id) AS revisions,
              c.id AS collab_id,
              (SELECT split_pct FROM collab_members m WHERE m.collab_id = c.id AND m.role = 'creator') AS creator_split,
              (SELECT split_pct FROM collab_members m WHERE m.collab_id = c.id AND m.role = 'builder') AS builder_split,
              i.status AS idea_status
       FROM proposals p
       LEFT JOIN collabs c ON c.proposal_id = p.id
       LEFT JOIN ideas i ON i.id = p.idea_id
       WHERE p.id = $1`,
      [proposalId],
    )
    return rows[0] ?? null
  })
}

/** The event types recorded about a subject, oldest first, with their properties. */
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

/** Wait for an email to `email` whose subject matches, sent after the test started. */
export async function expectEmail(email: string, subject: string | RegExp): Promise<void> {
  await expect
    .poll(
      async () => {
        const messages = (await listOutbox()).filter((message) =>
          message.to.includes(email.toLowerCase()),
        )
        return messages.some((message) =>
          typeof subject === "string" ? message.subject === subject : subject.test(message.subject),
        )
      },
      { message: `email "${String(subject)}" to ${email}`, timeout: 15_000 },
    )
    .toBe(true)
}

/** The id in `/app/proposals/<id>`. */
export function proposalIdFrom(url: string): string {
  const match = /\/app\/proposals\/([0-9a-f-]{36})/.exec(url)
  if (!match?.[1]) throw new Error(`no proposal id in ${url}`)
  return match[1]
}

/** How far the page scrolls sideways (0 or less: it doesn't). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement
    return root.scrollWidth - window.innerWidth
  })
}
