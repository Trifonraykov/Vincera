import { latestEmailTo } from "@/lib/email/outbox"

import { expect, test } from "./fixtures"
import { E2E_ADMIN_EMAIL, uniqueEmail } from "./helpers/accounts"
import { chooseRole, requestMagicLink, signIn, signOutFromApp, signUp } from "./helpers/auth"
import { completeOnboardingInDb } from "./helpers/db"

/**
 * Phase 0 acceptance (CLAUDE.md §16): a user can sign up, sign in and sign out; /admin is blocked
 * for non-admins. Runs with FAKE_SERVICES=all: magic links come from the fake outbox. Onboarding
 * past the role step is set up in the database (`completeOnboardingInDb`); the onboarding pages
 * have their own spec.
 */

test.describe("authentication", () => {
  test("signs in with the code from the email, where the link was asked for", async ({ page }) => {
    // The installed app on iOS keeps its own cookies: a link tapped in Mail would sign Safari in,
    // so the app takes the code from the same email instead (CLAUDE.md §19.19).
    const email = uniqueEmail("code")
    await page.goto("/sign-in")
    await page.getByLabel("Email", { exact: true }).fill(email)
    await page.getByRole("button", { name: "Email me a sign-in link" }).click()
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible()

    let code = ""
    await expect
      .poll(async () => {
        const message = await latestEmailTo(email)
        code = message?.text.match(/\b([0-9A-Z]{4}-[0-9A-Z]{4})\b/)?.[1] ?? ""
        return code
      })
      .not.toBe("")

    // A malformed code is caught on the page; the real one, typed in lower case, signs in.
    const field = page.getByLabel("Sign-in code")
    await field.fill("abc")
    await page.getByRole("button", { name: "Sign in with code" }).click()
    await expect(page.getByText(/Enter the 8-character code/)).toBeVisible()
    await field.fill(code.toLowerCase())
    await page.getByRole("button", { name: "Sign in with code" }).click()
    await expect(page).toHaveURL(/\/onboarding\/role$/)

    // The code worked once: the link in the same email is now used up.
    const link = (await latestEmailTo(email))?.text.match(/https?:\/\/\S+callback\/email\S+/)?.[0]
    expect(link && new URL(link).searchParams.get("token")).toBe(code.replace("-", ""))
  })

  test("sign up, onboard, sign out, sign in again and switch roles", async ({ page }) => {
    const email = uniqueEmail("creator")

    // (a) Sign up with a new email → magic link → onboarding → creator → the creator steps.
    await signUp(page, email, "Ada Creator")
    await expect(page).toHaveURL(/\/onboarding\/role$/)
    await expect(page.getByRole("heading", { name: /Welcome, Ada/ })).toBeVisible()
    await chooseRole(page, "creator")
    await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
    // Unfinished onboarding keeps /app closed.
    await page.goto("/app")
    await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
    // The onboarding steps themselves are covered by the onboarding spec.
    await completeOnboardingInDb(email)
    await page.goto("/app")
    await expect(page).toHaveURL(/\/app$/)
    await expect(page.getByRole("heading", { name: "Creator home" })).toBeVisible()

    // Signed-in users skip the auth pages, never to another site.
    await page.goto("/sign-in")
    await expect(page).toHaveURL(/\/app$/)
    await page.goto("/sign-in?callbackUrl=%2F.%2F%2Fevil.example%2Fphish")
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/app$/)

    // (b) Sign out from the user menu → /app redirects to /sign-in with a callbackUrl.
    await signOutFromApp(page, /Ada Creator/)
    await expect(page).toHaveURL(/\/$/)
    await page.goto("/app/ideas")
    await expect(page).toHaveURL(/\/sign-in\?callbackUrl=%2Fapp%2Fideas$/)

    // (c) Sign in again with a new magic link; it returns to the app.
    const link = await signIn(page, email, "/sign-in?callbackUrl=%2Fapp")
    await expect(page).toHaveURL(/\/app$/)
    await expect(page.getByRole("heading", { name: "Creator home" })).toBeVisible()

    // The role switcher: add the builder role (which continues with the builder's onboarding
    // steps), then switch back to creator.
    await page.getByRole("button", { name: /Switch role/ }).click()
    await page.getByRole("menuitem", { name: "Become a builder" }).click()
    await chooseRole(page, "builder")
    await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)
    await completeOnboardingInDb(email)
    await page.goto("/app")
    await expect(page.getByRole("heading", { name: "Builder home" })).toBeVisible()
    await page.getByRole("button", { name: /Acting as Builder/ }).click()
    await page.getByRole("menuitem", { name: "Creator" }).click()
    await expect(page.getByRole("heading", { name: "Creator home" })).toBeVisible()

    // A magic link works once: reusing it shows a plain-language error.
    await signOutFromApp(page, /Ada Creator/)
    await page.goto(link)
    await expect(page).toHaveURL(/\/sign-in\?error=Verification$/)
    await expect(page.getByText(/sign-in link or code is invalid or has expired/)).toBeVisible()
  })

  test("non-admins are blocked from /admin", async ({ page }) => {
    // Signed out: /admin asks to sign in first.
    await page.goto("/admin")
    await expect(page).toHaveURL(/\/sign-in\?callbackUrl=%2Fadmin$/)

    // (d) A signed-in builder is sent back to the app.
    const email = uniqueEmail("builder")
    await signUp(page, email)
    await chooseRole(page, "builder")
    await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)
    await completeOnboardingInDb(email)
    await page.goto("/app")
    await expect(page.getByRole("heading", { name: "Builder home" })).toBeVisible()
    await page.goto("/admin")
    await expect(page).toHaveURL(/\/app$/)
    await expect(page.getByRole("heading", { name: "Builder home" })).toBeVisible()
  })

  test("an admin from ADMIN_EMAILS can open /admin", async ({ page }) => {
    // (e) The admin signs up; with no creator/builder role yet, /app sends them to onboarding.
    await signUp(page, E2E_ADMIN_EMAIL)
    await expect(page).toHaveURL(/\/onboarding\/role$/)

    await page.goto("/admin")
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.getByRole("heading", { name: "Admin overview" })).toBeVisible()
  })

  test("magic links are rate limited (§14), and Auth.js's own sign-in endpoint is closed", async ({
    page,
  }) => {
    // 10 per 10 minutes per email (and per IP; each test has its own IP, see fixtures.ts).
    const email = uniqueEmail("limited")
    for (let i = 0; i < 10; i++) {
      await page.goto("/sign-in")
      await requestMagicLink(page, email, { submit: "Email me a sign-in link" })
    }
    await page.goto("/sign-in")
    await page.getByLabel("Email").fill(email)
    await page.getByRole("button", { name: "Email me a sign-in link" }).click()
    await expect(page.getByText(/Too many sign-in attempts/)).toBeVisible()

    // Posting straight to Auth.js would skip the form's validation: the route refuses it.
    const direct = await page.request.post("/api/auth/signin/email", {
      form: { email: uniqueEmail("direct"), csrfToken: "x", callbackUrl: "/app" },
      maxRedirects: 0,
    })
    expect(direct.status()).toBe(405)
  })
})
