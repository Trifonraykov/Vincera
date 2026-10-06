import { randomBytes } from "node:crypto"

import type { Browser, Page } from "@playwright/test"

import { newId } from "@/lib/ids"

import { expect, test } from "./fixtures"
import { uniqueEmail } from "./helpers/accounts"
import { chooseRole, signUp } from "./helpers/auth"
import { buyerEmail, payOnFakeCheckout } from "./helpers/checkout"
import { collabIdFrom, collabState } from "./helpers/collabs"
import { releaseSocialAccount, withE2eDb } from "./helpers/db"
import { runJob } from "./helpers/jobs"
import { launchState, signedInAdmin } from "./helpers/launches"
import { transfersOf } from "./helpers/payouts"
import {
  addProject,
  fillBuilderProfile,
  fillCreatorProfile,
  uniqueHandle,
} from "./helpers/profiles"
import { expectEmail, proposalIdFrom, proposalState, userIdOf } from "./helpers/proposals"

/**
 * The §15 end-to-end happy path, in one test, on the desktop layout (CLAUDE.md §19.43):
 * 1. a creator and a builder sign up and finish onboarding through the pages (fake YouTube for the
 *    creator, a portfolio project for the builder, fake Stripe Connect for both);
 * 2. the creator posts an idea; the builder sends a proposal, the creator counters, the builder
 *    accepts;
 * 3. both sign the agreement; the launch is set up, approved by both members and by an admin;
 * 4. a buyer clicks the creator's tracked link and pays with the fake test card;
 * 5. access works, the ledger is split correctly, and the payout job transfers both shares only
 *    after the hold (the clock mocked through `/api/test/jobs/payouts-release`).
 */

const DAY_MS = 24 * 60 * 60 * 1000
const FAKE_CONNECT_PAGE = /\/api\/dev\/fake-stripe\/connect\/acct_fake_[0-9a-f]{16}\?link=link_/
/** The fake YouTube fixture "Quiet Kitchen" (tests/fixtures/social/youtube/quiet-kitchen.json). */
const QUIET_KITCHEN_CHANNEL_ID = "UCqU1etK1tchenR0ad5Ma8Xw"

const COMMENTS = [
  "Can you make a budget template for students? I never know where my money goes",
  "please make a budget spreadsheet, I'm broke by the 20th",
  "a budget template for students would be amazing",
].join("\n")

async function newBrowserPage(browser: Browser, baseURL: string): Promise<Page> {
  const [a, b] = [randomBytes(2).toString("hex"), randomBytes(2).toString("hex")]
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": `2001:db8::${a}:${b}` },
  })
  return context.newPage()
}

/** The onboarding payouts step with fake Stripe Connect, ending on `/app`. */
async function finishPayoutsStep(page: Page) {
  await expect(page).toHaveURL(/\/onboarding\/payouts$/)
  const picker = page.getByLabel(/Country you.ll be paid in/)
  if ((await picker.inputValue()) === "") await picker.selectOption({ label: "Spain" })
  await page.getByRole("button", { name: "Set up payouts with Stripe" }).click()
  await expect(page).toHaveURL(FAKE_CONNECT_PAGE)
  await page.getByRole("button", { name: "Complete onboarding" }).click()
  await expect(page).toHaveURL(/\/onboarding\/payouts\?return=1$/)
  await expect(page.getByText("Payouts are ready", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: /^(Finish|Continue)$/ }).click()
  await expect(page).toHaveURL(/\/app$/)
}

async function onboardCreator(page: Page, email: string) {
  await signUp(page, email, "Hana Creator")
  await chooseRole(page, "creator")
  await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
  await fillCreatorProfile(page, {
    handle: uniqueHandle("hana"),
    niche: "Student money tips",
    country: "Germany",
    languages: ["English"],
  })
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(page).toHaveURL(/\/onboarding\/creator\/connect$/)
  await releaseSocialAccount("youtube", QUIET_KITCHEN_CHANNEL_ID)
  const youtube = page.getByRole("region", { name: "YouTube" })
  await youtube.getByRole("link", { name: "Connect YouTube" }).click()
  await expect(page).toHaveURL(/\/api\/dev\/fake-oauth\/youtube\/authorize\?/)
  await page.getByRole("button", { name: /Authorize as Quiet Kitchen/ }).click()
  await expect(page).toHaveURL(/\/onboarding\/creator\/connect\?connected=youtube$/)
  await expect(youtube.getByText("Verified")).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(page).toHaveURL(/\/onboarding\/creator\/review$/)
  await expect(page.getByLabel("Audience summary")).toHaveValue(/\S/, { timeout: 30_000 })
  await page.getByRole("button", { name: "Continue" }).click()
  await finishPayoutsStep(page)
}

async function onboardBuilder(page: Page, email: string) {
  await signUp(page, email, "Ravi Builder")
  await chooseRole(page, "builder")
  await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)
  await fillBuilderProfile(page, {
    handle: uniqueHandle("ravi"),
    bio: "I build small money tools.",
    skills: "spreadsheets, web apps",
    stack: "typescript",
    availability: "Open to new collabs",
    dealPreference: "Revenue split",
  })
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(page).toHaveURL(/\/onboarding\/builder\/portfolio$/)
  await addProject(page, {
    title: "Rent splitter",
    url: "https://rent.example.com",
    format: "Template",
    shipped: true,
  })
  await page.getByRole("button", { name: "Continue" }).click()
  await finishPayoutsStep(page)
}

/** What the split rule (§9) gives: platform fee half up, members by largest remainder. */
function expectedSplit(input: {
  gross: number
  tax: number
  fee: number
  creatorPct: number
  builderPct: number
  takeRate: number
}) {
  const net = input.gross - input.tax - input.fee
  const platform = Math.round(net * input.takeRate)
  const distributable = net - platform
  const exact = [input.creatorPct, input.builderPct].map((pct) => (distributable * pct) / 100)
  const floors = exact.map(Math.floor)
  let left = distributable - floors[0]! - floors[1]!
  // Two members: the larger remainder first (ties are not possible with a 65/35 split here).
  const order = [0, 1].sort((a, b) => exact[b]! - floors[b]! - (exact[a]! - floors[a]!))
  for (const index of order) {
    if (left <= 0) break
    floors[index]! += 1
    left -= 1
  }
  return { platform, creator: floors[0]!, builder: floors[1]! }
}

test("§15 happy path: onboarding, proposal, agreement, launch, purchase, ledger and payout", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(480_000)
  if (!baseURL) throw new Error("baseURL is not set")

  // --- 1. Both sides sign up and finish onboarding ----------------------------------------------
  const creatorEmail = uniqueEmail("happy-creator")
  const builderEmail = uniqueEmail("happy-builder")
  const c = await newBrowserPage(browser, baseURL)
  const b = await newBrowserPage(browser, baseURL)
  await onboardCreator(c, creatorEmail)
  await onboardBuilder(b, builderEmail)
  const creatorId = await userIdOf(creatorEmail)
  const builderId = await userIdOf(builderEmail)

  // The creator posts an idea from audience comments.
  await c.goto("/app/ideas/new")
  await c.getByLabel("Audience comments").fill(COMMENTS)
  await c.getByRole("button", { name: "Draft my idea" }).click()
  await expect(c.getByLabel("Title")).toHaveValue("Budget template for students")
  await c.getByRole("button", { name: "Publish" }).click()
  await expect(c).toHaveURL(/\/app\/ideas\/[0-9a-f-]{36}\?saved=published$/)
  const ideaId = /\/app\/ideas\/([0-9a-f-]{36})/.exec(c.url())?.[1] ?? ""

  // --- 2. Builder proposes, creator counters, builder accepts ---------------------------------
  await b.goto(`/app/proposals/new?to=${creatorId}&idea=${ideaId}`)
  await b.getByLabel("What you'll build together").fill("A budget template with a monthly view.")
  await b.getByLabel("Creator %").fill("55")
  await expect(b.getByLabel("Builder %")).toHaveValue("45")
  await b.getByLabel("Timeline (weeks)").fill("4")
  await b.getByRole("button", { name: "Send proposal" }).click()
  await expect(b).toHaveURL(/\/app\/proposals\/[0-9a-f-]{36}\?sent=1$/)
  const proposalId = proposalIdFrom(b.url())
  await expectEmail(creatorEmail, "Ravi Builder sent you a proposal")

  await c.goto(`/app/proposals/${proposalId}`)
  await c.getByRole("button", { name: "Counter" }).click()
  const sheet = c.getByRole("dialog", { name: "Your counter-offer" })
  await sheet.getByLabel("Creator %").fill("65")
  await expect(sheet.getByLabel("Builder %")).toHaveValue("35")
  await sheet.getByRole("button", { name: "Send counter-offer" }).click()
  await expect(sheet).toBeHidden()
  await expectEmail(builderEmail, "Hana Creator countered your proposal")

  await b.goto(`/app/proposals/${proposalId}`)
  await b.getByRole("button", { name: "Accept", exact: true }).click()
  const confirm = b.getByRole("dialog", { name: "Accept these terms?" })
  await expect(confirm).toContainText("Creator 65% · Builder 35%")
  await confirm.getByRole("button", { name: "Accept and start the collab" }).click()
  await expect(b.getByText("Accepted: you're collaborating")).toBeVisible()
  expect(await proposalState(proposalId)).toMatchObject({
    status: "accepted",
    revisions: 2,
    creator_split: 65,
    builder_split: 35,
  })
  await b.getByRole("link", { name: "Open the collab" }).click()
  await expect(b).toHaveURL(/\/app\/collabs\/[0-9a-f-]{36}$/)
  const collabId = collabIdFrom(b.url())

  // --- 3. Both sign (payouts are already ready from onboarding) ---------------------------------
  for (const [page, name] of [
    [c, "Hana Creator"],
    [b, "Ravi Builder"],
  ] as const) {
    await page.goto(`/app/collabs/${collabId}/agreement`)
    await page.getByLabel("Type your full name to sign").fill(name)
    await page.getByRole("button", { name: "Sign the agreement" }).click()
    await expect(page.getByText(/You signed|Signed by both of you/).first()).toBeVisible()
  }
  await expect
    .poll(async () => (await collabState(collabId))?.pdf_storage_key ?? null, {
      timeout: 60_000,
    })
    .not.toBeNull()
  expect(await collabState(collabId)).toMatchObject({
    stage: "building",
    agreement_status: "signed",
    signatures: 2,
  })

  // The launch: set up by the creator, approved by both members, then by an admin.
  const slug = `budget-template-${Date.now().toString(36)}`
  const title = "Budget template for students"
  await c.goto(`/app/collabs/${collabId}/launch`)
  await c.getByRole("button", { name: "Set up the launch" }).click()
  await expect(c.getByLabel("Title")).toHaveValue(title)
  await c.getByLabel("Tagline").fill("Know where your money goes")
  await c.getByLabel("Page address").fill(slug)
  await c.getByLabel("Description").fill("A **monthly budget** for students.")
  await c.getByLabel("Price").fill("49")
  await c.locator("label").filter({ hasText: "A link" }).click()
  await c.getByLabel("Link buyers are sent to").fill("https://budget.example.com/welcome")
  await c.getByRole("button", { name: "Save launch" }).click()
  await expect(c.getByText("Saved.", { exact: true })).toBeVisible()
  for (const [page, expected] of [
    [c, "Waiting for approval"],
    [b, "In review"],
  ] as const) {
    await page.goto(`/app/collabs/${collabId}/launch`)
    await page.getByRole("button", { name: "Approve this version" }).click()
    await expect(page.getByText(expected, { exact: true }).first()).toBeVisible()
  }
  expect(await launchState(collabId)).toMatchObject({ status: "admin_review" })

  const admin = await signedInAdmin(browser, baseURL)
  await admin.goto("/admin/launches")
  const card = admin.getByRole("article", { name: title })
  await card.getByRole("button", { name: "Approve and go live" }).click()
  await expect(card).toHaveCount(0)
  const launch = await launchState(collabId)
  expect(launch).toMatchObject({ status: "live", stage: "live", slug })
  expect(launch?.link_code).toMatch(/^[0-9A-Za-z]{8}$/)

  // --- 4. A buyer clicks the tracked link and pays with the test card ---------------------------
  const buyer = await newBrowserPage(browser, baseURL)
  const email = buyerEmail()
  await buyer.goto(`/r/${launch?.link_code}`)
  await expect(buyer).toHaveURL(new RegExp(`/p/${slug}\\?ref=${launch?.link_code}$`))
  await expect(buyer.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await expect(buyer.getByText(/by @\w+ × @\w+/)).toBeVisible()
  await buyer.getByRole("button", { name: "Buy for €49.00" }).click()
  await payOnFakeCheckout(buyer, email, "DE")
  await expect(
    buyer.getByRole("heading", { name: "Thanks, your payment went through" }),
  ).toBeVisible({ timeout: 20_000 })

  // --- 5. Access works -------------------------------------------------------------------------
  // A link delivery: the access page sends the buyer on to the URL (not reachable here, so the
  // redirect is checked rather than followed).
  const accessHref = await buyer
    .getByRole("link", { name: "Open your purchase" })
    .getAttribute("href")
  expect(accessHref).toMatch(/^\/access\/[A-Za-z0-9_-]{43}$/)
  const order = await withE2eDb(async (pool) => {
    const { rows } = await pool.query<{
      id: string
      paid_at: Date
      status: string
      gross: number
      tax: number
      fee: number
      tracked_link_id: string | null
      ledger_posted: boolean
      token: string
    }>(
      `SELECT o.id, o.paid_at, o.status, o.amount_gross_cents AS gross, o.tax_cents AS tax,
              o.stripe_fee_cents AS fee, o.tracked_link_id, o.ledger_posted_at IS NOT NULL AS ledger_posted,
              g.token
       FROM orders o JOIN launches l ON l.id = o.launch_id
       JOIN access_grants g ON g.order_id = o.id
       WHERE l.collab_id = $1 AND o.buyer_email = $2`,
      [collabId, email],
    )
    return rows[0]
  })
  if (!order) throw new Error("no order")
  expect(order).toMatchObject({
    status: "paid",
    gross: 4900,
    tracked_link_id: launch?.link_id,
    ledger_posted: true,
  })
  expect(accessHref).toBe(`/access/${order.token}`)
  const access = await buyer.request.get(`/access/${order.token}`, { maxRedirects: 0 })
  expect(access.status()).toBeGreaterThanOrEqual(300)
  expect(access.status()).toBeLessThan(400)
  expect(access.headers().location).toBe("https://budget.example.com/welcome")
  await expectEmail(email, `Your purchase: ${title}`)

  // The ledger: every component written, summing to gross, shares split 65/35 (§9).
  const entries = await withE2eDb(async (pool) => {
    const { rows } = await pool.query<{
      account: string
      user_id: string | null
      amount_cents: number
      available_at: Date
    }>(
      "SELECT account, user_id, amount_cents, available_at FROM ledger_entries WHERE order_id = $1",
      [order.id],
    )
    return rows
  })
  const byAccount = (account: string) =>
    entries.filter((entry) => entry.account === account).reduce((s, e) => s + e.amount_cents, 0)
  expect(entries.reduce((sum, entry) => sum + entry.amount_cents, 0)).toBe(order.gross)
  expect(byAccount("tax")).toBe(order.tax)
  expect(byAccount("stripe_fee")).toBe(order.fee)
  const split = expectedSplit({
    gross: order.gross,
    tax: order.tax,
    fee: order.fee,
    creatorPct: 65,
    builderPct: 35,
    takeRate: 0.1,
  })
  expect(byAccount("platform_fee")).toBe(split.platform)
  const creatorEntry = entries.find((entry) => entry.account === "creator_share")
  const builderEntry = entries.find((entry) => entry.account === "builder_share")
  expect(creatorEntry).toMatchObject({ user_id: creatorId, amount_cents: split.creator })
  expect(builderEntry).toMatchObject({ user_id: builderId, amount_cents: split.builder })
  const paidAt = new Date(order.paid_at)
  for (const entry of entries) {
    expect(new Date(entry.available_at).getTime()).toBe(paidAt.getTime() + 14 * DAY_MS)
  }

  // --- The payout job: nothing during the hold, both shares once after it ------------------------
  await runJob(c.request, "payouts-release", {
    now: new Date(paidAt.getTime() + DAY_MS),
    data: { runKey: `manual:${newId()}` },
  })
  expect(await transfersOf(creatorId)).toEqual([])
  expect(await transfersOf(builderId)).toEqual([])

  const afterHold = new Date(paidAt.getTime() + 15 * DAY_MS)
  await runJob(c.request, "payouts-release", {
    now: afterHold,
    data: { runKey: `manual:${newId()}` },
  })
  for (const [userId, cents] of [
    [creatorId, split.creator],
    [builderId, split.builder],
  ] as const) {
    const transfers = await transfersOf(userId)
    expect(transfers).toHaveLength(1)
    expect(transfers[0]).toMatchObject({ amount_cents: cents, status: "created" })
    expect(transfers[0]?.stripe_transfer_id).toMatch(/^tr_fake_/)
  }
  const transferred = await withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_entries
       WHERE order_id = $1 AND user_id IS NOT NULL AND transfer_id IS NULL`,
      [order.id],
    )
    return rows[0]?.n ?? -1
  })
  expect(transferred).toBe(0)

  for (const page of [c, b, admin, buyer]) await page.context().close()
})
