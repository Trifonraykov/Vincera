import { expect, type Page } from "@playwright/test"

import { listOutbox, type OutboxEmail } from "@/lib/email/outbox"

import { withE2eDb } from "./db"
import { proposalIdFrom, type Person } from "./proposals"

/**
 * Collabs, agreements and tasks in the browser (CLAUDE.md §19.28): a collab made through the real
 * proposal pages, payouts set up through the fake Stripe Connect pages (§19.12), and reads of what
 * the pages wrote.
 */

const FAKE_CONNECT_PAGE = /\/api\/dev\/fake-stripe\/connect\/acct_fake_[0-9a-f]{16}\?link=link_/

/**
 * Finish fake Stripe Connect from Settings → Payouts: the signed `account.updated` reaches the
 * real webhook and the account becomes payouts-ready.
 */
export async function setUpPayouts(page: Page): Promise<void> {
  await page.goto("/app/settings/payouts")
  const picker = page.getByLabel(/Country you.ll be paid in/)
  if ((await picker.count()) > 0 && (await picker.inputValue()) === "") {
    await picker.selectOption({ label: "Spain" })
  }
  await page.getByRole("button", { name: "Set up payouts with Stripe" }).click()
  await expect(page).toHaveURL(FAKE_CONNECT_PAGE)
  await page.getByRole("button", { name: "Complete onboarding" }).click()
  await expect(page).toHaveURL(/\/app\/settings\/payouts\?return=1$/)
  await expect(page.getByText("Payouts are ready", { exact: true })).toBeVisible()
}

/** The builder pitches on the creator's idea through the proposal form; returns the proposal id. */
export async function sendPitch(builder: Person, creator: Person, ideaId: string): Promise<string> {
  const page = builder.page
  await page.goto(`/app/proposals/new?to=${creator.userId}&idea=${ideaId}`)
  await page
    .getByLabel("What you'll build together")
    .fill("A web app: weekly meal plans and a shopping list.")
  await page.getByLabel("Creator %").fill("60")
  await page.getByLabel("Timeline (weeks)").fill("6")
  await page.getByRole("button", { name: "Send proposal" }).click()
  await expect(page).toHaveURL(/\/app\/proposals\/[0-9a-f-]{36}\?sent=1$/)
  return proposalIdFrom(page.url())
}

/** The person accepts the proposal on its page and opens the new collab; returns its id. */
export async function acceptAndOpenCollab(person: Person, proposalId: string): Promise<string> {
  const page = person.page
  await page.goto(`/app/proposals/${proposalId}`)
  await page.getByRole("button", { name: "Accept", exact: true }).click()
  await page
    .getByRole("dialog", { name: "Accept these terms?" })
    .getByRole("button", { name: "Accept and start the collab" })
    .click()
  await expect(page.getByText("Accepted: you're collaborating")).toBeVisible()
  await page.getByRole("link", { name: "Open the collab" }).click()
  await expect(page).toHaveURL(/\/app\/collabs\/[0-9a-f-]{36}$/)
  return collabIdFrom(page.url())
}

export function collabIdFrom(url: string): string {
  const match = /\/app\/collabs\/([0-9a-f-]{36})/.exec(url)
  if (!match?.[1]) throw new Error(`no collab id in ${url}`)
  return match[1]
}

export type CollabState = {
  stage: string
  agreement_id: string | null
  agreement_status: string | null
  pdf_storage_key: string | null
  signatures: number
}

export async function collabState(collabId: string): Promise<CollabState | null> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<CollabState>(
      `SELECT c.stage, a.id AS agreement_id, a.status AS agreement_status, a.pdf_storage_key,
              (SELECT count(*)::int FROM agreement_signatures s WHERE s.agreement_id = a.id) AS signatures
       FROM collabs c
       LEFT JOIN agreements a ON a.collab_id = c.id AND a.status <> 'terminated'
       WHERE c.id = $1`,
      [collabId],
    )
    return rows[0] ?? null
  })
}

/** The task events of a collab, oldest first (`task.*` carry the collab's id). */
export async function taskEventTypes(collabId: string): Promise<string[]> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ type: string }>(
      `SELECT type FROM events
       WHERE type LIKE 'task.%' AND properties->>'collab_id' = $1
       ORDER BY occurred_at, id`,
      [collabId],
    )
    return rows.map((row) => row.type)
  })
}

/** Emails to `email` whose subject matches, sent during this run. */
export async function emailsTo(email: string, subject: string): Promise<OutboxEmail[]> {
  return (await listOutbox()).filter(
    (message) => message.to.includes(email.toLowerCase()) && message.subject === subject,
  )
}
