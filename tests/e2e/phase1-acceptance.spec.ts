import { randomBytes } from "node:crypto"

import { newId } from "@/lib/ids"

import { expect, test } from "./fixtures"
import { uniqueEmail } from "./helpers/accounts"
import { chooseRole, signUp } from "./helpers/auth"
import { completeOnboardingInDb, withE2eDb } from "./helpers/db"
import { runJob } from "./helpers/jobs"
import { fillBuilderProfile, fillCreatorProfile, uniqueHandle } from "./helpers/profiles"

/**
 * Phase 1 acceptance (§16): "A creator connects YouTube and sees /app/audience with real data.
 * A builder connects GitHub. Both complete Stripe test onboarding. /c/[handle] and /b/[handle]
 * render." Plus the manual-entry fallback (§7.1) showing "Unverified".
 *
 * Everything runs against the fakes (FAKE_SERVICES=all, §19.3): the fake consent pages redirect
 * to our real OAuth callback, the first sync runs the real job after the response (fixture data
 * through the real provider parsers, fake Claude and embeddings), and fake Stripe Connect posts a
 * signed webhook to the real handler.
 *
 * Every step goes through the pages, the profile forms included (the manual-entry test sets its
 * profile up in the database; its subject is the fallback).
 */

const FAKE_CONNECT_PAGE = /\/api\/dev\/fake-stripe\/connect\/acct_fake_[0-9a-f]{16}\?link=link_/
const countryPicker = /Country you.ll be paid in/

/** The creator profile step, done in the database (for the manual-entry test). */
async function createCreatorProfileInDb(email: string, displayName: string): Promise<string> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
      email.toLowerCase(),
    ])
    const user = rows[0]
    if (!user) throw new Error(`createCreatorProfileInDb: no user with email ${email}`)
    const handle = `e2e_${randomBytes(5).toString("hex")}`
    await pool.query("INSERT INTO handles (handle, user_id) VALUES ($1, $2)", [handle, user.id])
    await pool.query(
      `INSERT INTO creator_profiles (id, user_id, handle, display_name, niche, country, languages)
       VALUES ($1, $2, $3, $4, 'Notion and productivity tutorials', 'DE', ARRAY['en', 'es'])`,
      [newId(), user.id, handle, displayName],
    )
    return handle
  })
}

async function completeFakeStripeOnboarding(page: import("@playwright/test").Page) {
  await expect(page.getByRole("heading", { name: "Get paid for what you sell" })).toBeVisible()
  const picker = page.getByLabel(countryPicker)
  if ((await picker.inputValue()) === "") await picker.selectOption({ label: "Spain" })
  await page.getByRole("button", { name: "Set up payouts with Stripe" }).click()
  await expect(page).toHaveURL(FAKE_CONNECT_PAGE)
  await page.getByRole("button", { name: "Complete onboarding" }).click()
  await expect(page).toHaveURL(/\/onboarding\/payouts\?return=1$/)
  await expect(page.getByText("Payouts are ready", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: /^(Finish|Continue)$/ }).click()
  await expect(page).toHaveURL(/\/app$/)
}

test.describe("Phase 1 acceptance", () => {
  test("a creator connects YouTube, reviews the AI summary, sets up payouts and sees real audience data", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const email = uniqueEmail("creator-p1")
    await signUp(page, email, "Ada Creator")
    await chooseRole(page, "creator")
    await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)

    // Profile step: the form starts from the account name.
    await expect(page.getByRole("heading", { name: "Set up your creator profile" })).toBeVisible()
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Ada Creator")
    const handle = uniqueHandle("ada")
    await fillCreatorProfile(page, {
      handle,
      niche: "Notion and productivity tutorials",
      country: "Germany",
      languages: ["English", "Spanish"],
    })
    await page.getByRole("button", { name: "Continue" }).click()

    // Connect step: YouTube is recommended; the fake consent page stands in for Google.
    await expect(page).toHaveURL(/\/onboarding\/creator\/connect$/)
    await expect(
      page.getByRole("heading", { name: "Connect where your audience is" }),
    ).toBeVisible()
    const youtube = page.getByRole("region", { name: "YouTube" })
    await expect(youtube.getByText("Recommended")).toBeVisible()
    await expect(page.getByRole("region", { name: "Instagram" })).toContainText(
      "Business or Creator account",
    )
    await youtube.getByRole("link", { name: "Connect YouTube" }).click()
    await expect(page).toHaveURL(/\/api\/dev\/fake-oauth\/youtube\/authorize\?/)
    await page.getByRole("button", { name: /Authorize as Ada Codes/ }).click()

    await expect(page).toHaveURL(/\/onboarding\/creator\/connect\?connected=youtube$/)
    await expect(page.getByText("YouTube connected")).toBeVisible()
    // The first sync runs in the background; the page refreshes until it lands.
    await expect(youtube.getByText("Verified")).toBeVisible({ timeout: 30_000 })
    await expect(youtube).toContainText("48.2K")
    await page.getByRole("button", { name: "Continue" }).click()

    // Review step: the AI summary (fake Claude) is editable next to the key stats.
    await expect(page).toHaveURL(/\/onboarding\/creator\/review$/)
    const summary = page.getByLabel("Audience summary")
    await expect(summary).toHaveValue(/\S/, { timeout: 30_000 })
    await expect(page.getByLabel("Topics")).not.toHaveValue("")
    await expect(page.getByText("Written by AI from your stats")).toBeVisible()
    await expect(page.getByText("Micro creator")).toBeVisible()
    await summary.fill(
      "Spanish-speaking students and freelancers who want to get organised with Notion.",
    )
    await page.getByRole("button", { name: "Continue" }).click()

    // Payouts with fake Stripe Connect (the creator profile's country preselects Germany).
    await expect(page).toHaveURL(/\/onboarding\/payouts$/)
    await expect(page.getByLabel(countryPicker)).toHaveValue("DE")
    await completeFakeStripeOnboarding(page)

    // /app/audience with the fixture channel's data.
    await page.goto("/app/audience")
    await expect(page.getByRole("heading", { name: "Audience", exact: true })).toBeVisible()
    await expect(page.getByText("48.2K").first()).toBeVisible()
    await expect(page.getByText("Micro creator")).toBeVisible()
    await expect(
      page.getByText("Spanish-speaking students and freelancers who want to get organised"),
    ).toBeVisible()
    await expect(page.getByText("Edited by you; syncs keep your version")).toBeVisible()
    const countries = page.getByRole("table", { name: /YouTube: top countries/ })
    await expect(countries.getByRole("rowheader").first()).toHaveText("Spain")
    await expect(page.getByText(/shares of viewers, not of subscribers/)).toBeVisible()
    await expect(page.getByText("Female", { exact: true }).first()).toBeVisible()
    await page.getByText("Show as a table").click()
    await expect(page.getByRole("table", { name: /share of viewers by age group/ })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Connection health" })).toBeVisible()
    await page.getByRole("button", { name: "Resync YouTube" }).click()
    await expect(page.getByText("Sync started. New numbers appear shortly.")).toBeVisible()

    // The retention job runs (YOUTUBE_LONG_RETENTION=false) and keeps the newest snapshot.
    const retention = await runJob(request, "social-youtube-retention")
    expect(retention).toMatchObject({ skipped: false })
    await page.reload()
    await expect(page.getByText("48.2K").first()).toBeVisible()

    // Public creator profile.
    await page.goto(`/c/${handle}`)
    await expect(page.getByRole("heading", { level: 1, name: "Ada Creator" })).toBeVisible()
    await expect(page.getByText("@" + handle)).toBeVisible()
    await expect(page.getByText("Micro creator")).toBeVisible()
    await expect(page.getByText("Spanish-speaking students and freelancers")).toBeVisible()
    await expect(page.getByText("Verified", { exact: true })).toBeVisible()
    await expect(page.getByRole("link", { name: /View on YouTube/ })).toBeVisible()
    await expect(page).toHaveTitle(new RegExp(`^Ada Creator \\(@${handle}\\) · Creator`))
    // Languages are shown by name.
    await expect(page.getByText(/English, Spanish/)).toBeVisible()
    // No demographics or contact details on the public page.
    await expect(page.getByText(email)).toHaveCount(0)
    await expect(page.getByText("Spain")).toHaveCount(0)

    expect((await page.goto("/c/no_such_handle_e2e"))?.status()).toBe(404)
  })

  test("a builder connects GitHub, sets up payouts and their profile shows GitHub stats", async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const email = uniqueEmail("builder-p1")
    await signUp(page, email, "Octo Builder")
    await chooseRole(page, "builder")
    await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)

    // Profile step.
    const handle = uniqueHandle("octo")
    await fillBuilderProfile(page, {
      handle,
      bio: "I build small tools.",
      skills: "web apps",
      stack: "typescript",
      availability: "Open to new collabs",
      dealPreference: "Revenue split",
    })
    await page.getByRole("button", { name: "Continue" }).click()

    // Portfolio step: connecting GitHub completes it.
    await expect(page).toHaveURL(/\/onboarding\/builder\/portfolio$/)
    await expect(page.getByRole("heading", { name: "Show what you've built" })).toBeVisible()
    await page
      .getByRole("region", { name: "GitHub" })
      .getByRole("link", { name: "Connect GitHub" })
      .click()
    await expect(page).toHaveURL(/\/api\/dev\/fake-oauth\/github\/authorize\?/)
    await expect(page.getByText(/Requested access: public, read-only data/)).toBeVisible()
    await page.getByRole("button", { name: /Authorize as octo-builder/ }).click()
    await expect(page).toHaveURL(/\/onboarding\/builder\/portfolio\?connected=github$/)
    await expect(page.getByText("GitHub connected")).toBeVisible()

    // The GitHub connection lets the builder continue: payouts are next.
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(page).toHaveURL(/\/onboarding\/payouts$/)
    await completeFakeStripeOnboarding(page)

    await page.goto("/app/settings/connections")
    const github = page.getByRole("region", { name: "GitHub" })
    await expect(github.getByText("Verified")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("region", { name: "YouTube" })).toHaveCount(0)

    await page.goto(`/b/${handle}`)
    await expect(page.getByRole("heading", { level: 1, name: "Octo Builder" })).toBeVisible()
    await expect(page.getByText("Open to new collabs")).toBeVisible()
    await expect(page.getByRole("heading", { name: "GitHub" })).toBeVisible()
    await expect(page.getByText("Stars earned")).toBeVisible()
    await expect(page.getByRole("table", { name: /Top languages/ })).toContainText("TypeScript")
    await expect(page.getByText("typescript", { exact: true })).toBeVisible()
  })

  test("manual entry shows as Unverified until an admin checks it", async ({ page }) => {
    test.setTimeout(120_000)
    const email = uniqueEmail("manual-p1")
    await signUp(page, email, "Luna Manual")
    await chooseRole(page, "creator")
    await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
    const handle = await createCreatorProfileInDb(email, "Luna Manual")

    await page.goto("/onboarding/creator/connect")
    const instagram = page.getByRole("region", { name: "Instagram" })
    await instagram.getByRole("button", { name: "Enter manually" }).click()
    const dialog = page.getByRole("dialog", { name: "Enter your Instagram numbers" })
    await dialog.getByLabel("Link to your Instagram profile").fill("https://www.instagram.com/luna")
    await dialog.getByLabel("Followers").fill("12,500")
    await dialog.getByLabel("Screenshot showing the count").setInputFiles({
      name: "followers.png",
      mimeType: "image/png",
      buffer: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    })
    await dialog.getByRole("button", { name: "Save numbers" }).click()
    await expect(dialog).toBeHidden()

    await expect(instagram.getByText("Unverified", { exact: true })).toBeVisible()
    await expect(instagram).toContainText("12.5K")
    await page.getByRole("button", { name: "Continue" }).click()

    await expect(page).toHaveURL(/\/onboarding\/creator\/review$/)
    await expect(page.getByText("Micro creator")).toBeVisible()
    await expect(page.getByText("Unverified").first()).toBeVisible()
    await expect(page.getByText(/uses your largest self-reported platform/)).toBeVisible()

    await completeOnboardingInDb(email)
    await page.goto(`/c/${handle}`)
    await expect(page.getByRole("heading", { level: 1, name: "Luna Manual" })).toBeVisible()
    await expect(page.getByText("Unverified").first()).toBeVisible()
    await expect(page.getByText("12.5K")).toBeVisible()
    // An unverified profile link is never shown publicly.
    await expect(page.getByRole("link", { name: /View on Instagram/ })).toHaveCount(0)
  })
})
