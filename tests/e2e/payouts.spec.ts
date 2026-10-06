import { randomBytes } from "node:crypto"

import { latestEmailTo } from "@/lib/email/outbox"
import { newId } from "@/lib/ids"

import { expect, test } from "./fixtures"
import { uniqueEmail } from "./helpers/accounts"
import { chooseRole, signUp } from "./helpers/auth"
import { completeOnboardingInDb, withE2eDb } from "./helpers/db"

/**
 * Stripe Connect payouts (§7.2, §16 Phase 1 "both complete Stripe test onboarding") with fake
 * Stripe (FAKE_SERVICES=all, §19.3, §19.12): the app creates the connected account, the fake
 * hosted onboarding page posts a signed `account.updated` to the real `/api/webhooks/stripe`, and
 * the payouts pages show the synced status. The profile and portfolio steps before payouts are
 * set up in the database; the onboarding spec walks those pages.
 */

const FAKE_CONNECT_PAGE = /\/api\/dev\/fake-stripe\/connect\/acct_fake_[0-9a-f]{16}\?link=link_/

/** Put a new builder at the payouts step: profile created, portfolio put off. */
async function builderAtPayoutsStep(email: string): Promise<void> {
  await withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
      email.toLowerCase(),
    ])
    const user = rows[0]
    if (!user) throw new Error(`builderAtPayoutsStep: no user with email ${email}`)
    const handle = `e2e_${randomBytes(5).toString("hex")}`
    await pool.query("INSERT INTO handles (handle, user_id) VALUES ($1, $2)", [handle, user.id])
    await pool.query(
      `INSERT INTO builder_profiles (id, user_id, handle, display_name) VALUES ($1, $2, $3, $4)`,
      [newId(), user.id, handle, "Payout Builder"],
    )
    const steps = { "builder.portfolio": { status: "skipped", at: new Date().toISOString() } }
    await pool.query(
      "UPDATE users SET onboarding_steps = onboarding_steps || $2::jsonb WHERE id = $1",
      [user.id, JSON.stringify(steps)],
    )
  })
}

type AccountState = {
  stripe_account_id: string
  country: string | null
  details_submitted: boolean
  payouts_enabled: boolean
  transfers_capability: string
  onboarding_completed: boolean
  webhook_events: number
}

/** The user's stripe_accounts row and how many account.updated webhooks were processed for it. */
async function accountStateOf(email: string): Promise<AccountState | null> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<AccountState>(
      `SELECT sa.stripe_account_id, sa.country, sa.details_submitted, sa.payouts_enabled,
              sa.transfers_capability, u.onboarding_completed_at IS NOT NULL AS onboarding_completed,
              (SELECT count(*)::int FROM stripe_events se
                WHERE se.account = sa.stripe_account_id AND se.type = 'account.updated'
                  AND se.processed_at IS NOT NULL) AS webhook_events
       FROM stripe_accounts sa JOIN users u ON u.id = sa.user_id
       WHERE u.email = $1`,
      [email.toLowerCase()],
    )
    return rows[0] ?? null
  })
}

const countryPicker = /Country you.ll be paid in/

test.describe("payouts (fake Stripe Connect)", () => {
  test("a builder sets up payouts during onboarding", async ({ page }) => {
    const email = uniqueEmail("payouts")
    await signUp(page, email)
    await chooseRole(page, "builder")
    await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)
    await builderAtPayoutsStep(email)

    await page.goto("/onboarding/payouts")
    await expect(page.getByRole("heading", { name: "Get paid for what you sell" })).toBeVisible()
    await expect(page.getByText("Payouts aren't set up yet", { exact: true })).toBeVisible()
    // Builder profiles have no country, so the picker starts empty and is required.
    await expect(page.getByLabel(countryPicker)).toHaveValue("")
    await page.getByLabel(countryPicker).selectOption({ label: "Spain" })
    await page.getByRole("button", { name: "Set up payouts with Stripe" }).click()

    // Fake Stripe-hosted onboarding. Leaving it changes nothing.
    await expect(page).toHaveURL(FAKE_CONNECT_PAGE)
    await expect(page.getByRole("heading", { name: "Set up payouts" })).toBeVisible()
    const firstLink = page.url()
    await page.getByRole("button", { name: "Return without finishing" }).click()
    await expect(page).toHaveURL(/\/onboarding\/payouts\?return=1$/)
    await expect(page.getByText("Stripe needs a few more details", { exact: true })).toBeVisible()
    expect(await accountStateOf(email)).toMatchObject({
      country: "ES",
      details_submitted: false,
      payouts_enabled: false,
      webhook_events: 0,
    })

    // Account links are single-use: the old one goes through Stripe's refresh_url
    // (/onboarding/payouts/refresh), which opens a fresh link.
    await page.goto(firstLink)
    await expect(page).toHaveURL(FAKE_CONNECT_PAGE)
    expect(page.url()).not.toBe(firstLink)

    // Finish onboarding: the fake delivers a signed account.updated to the real webhook.
    await page.getByRole("button", { name: "Complete onboarding" }).click()
    await expect(page).toHaveURL(/\/onboarding\/payouts\?return=1$/)
    await expect(page.getByText("Payouts are ready", { exact: true })).toBeVisible()
    expect(await accountStateOf(email)).toMatchObject({
      country: "ES",
      details_submitted: true,
      payouts_enabled: true,
      transfers_capability: "active",
      webhook_events: 1,
      // Payouts was the last step: the webhook finished onboarding.
      onboarding_completed: true,
    })

    // payouts.ready notification email (once).
    await expect
      .poll(async () => (await latestEmailTo(email))?.subject ?? null)
      .toBe("Your payouts are set up")

    await page.getByRole("button", { name: /^(Finish|Continue)$/ }).click()
    await expect(page).toHaveURL(/\/app$/)
  })

  test("settings: verification pending, then the Express dashboard", async ({ page }) => {
    const email = uniqueEmail("payouts-settings")
    await signUp(page, email)
    await chooseRole(page, "creator")
    await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
    // Onboarding done with payouts put off ("Do this later").
    await completeOnboardingInDb(email)

    await page.goto("/app/settings/payouts")
    await expect(page.getByRole("heading", { name: "Payouts", exact: true })).toBeVisible()
    await expect(page.getByText("Payouts aren't set up yet", { exact: true })).toBeVisible()
    await page.getByLabel(countryPicker).selectOption({ label: "Germany" })
    await page.getByRole("button", { name: "Set up payouts with Stripe" }).click()

    await expect(page).toHaveURL(FAKE_CONNECT_PAGE)
    await page.getByRole("button", { name: "Submit details (verification pending)" }).click()
    await expect(page).toHaveURL(/\/app\/settings\/payouts\?return=1$/)
    await expect(page.getByText("Stripe is checking your details", { exact: true })).toBeVisible()
    expect(await accountStateOf(email)).toMatchObject({
      country: "DE",
      details_submitted: true,
      payouts_enabled: false,
      transfers_capability: "pending",
      webhook_events: 1,
    })

    // The Express dashboard opens once the details were submitted.
    await page.getByRole("button", { name: "Open Stripe Express dashboard" }).click()
    await expect(page).toHaveURL(/\/api\/dev\/fake-stripe\/dashboard\/acct_fake_[0-9a-f]{16}$/)
    await expect(page.getByRole("heading", { name: "Express Dashboard" })).toBeVisible()
    await page.getByRole("link", { name: /^Back to / }).click()
    await expect(page).toHaveURL(/\/app\/settings\/payouts$/)
    await expect(page.getByText("Stripe is checking your details", { exact: true })).toBeVisible()
  })

  test("the webhook endpoint refuses unsigned and wrongly signed requests", async ({ request }) => {
    const body = { id: "evt_e2e_unsigned", object: "event", type: "account.updated" }
    const unsigned = await request.post("/api/webhooks/stripe", { data: body })
    expect(unsigned.status()).toBe(400)
    expect(await unsigned.json()).toEqual({ received: false, error: "missing_signature" })

    const forged = await request.post("/api/webhooks/stripe", {
      data: body,
      headers: { "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
    })
    expect(forged.status()).toBe(400)
    expect(await forged.json()).toEqual({ received: false, error: "invalid_signature" })
  })
})
