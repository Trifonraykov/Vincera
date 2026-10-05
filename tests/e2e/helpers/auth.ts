import { expect, type Page } from "@playwright/test"

import { extractUrls, latestEmailTo } from "@/lib/email/outbox"

/**
 * Auth helpers for e2e (FAKE_SERVICES=all): magic links are read from the fake email outbox
 * (`.data/outbox/`, CLAUDE.md §19.3) instead of a real inbox.
 */

const MAGIC_LINK_PATH = "/api/auth/callback/email"

/** The id of the newest email to `email`, so a later wait can skip it. */
export async function lastEmailId(email: string): Promise<string | null> {
  return (await latestEmailTo(email))?.id ?? null
}

/** Wait for a new magic-link email to `email` (newer than `previousId`) and return its link. */
export async function waitForMagicLink(email: string, previousId: string | null): Promise<string> {
  let link: string | undefined
  await expect
    .poll(
      async () => {
        const message = await latestEmailTo(email)
        if (!message || message.id === previousId) return null
        link = extractUrls(message).find((url) => url.includes(MAGIC_LINK_PATH))
        return link ?? null
      },
      { message: `magic link email to ${email}`, timeout: 15_000 },
    )
    .not.toBeNull()
  if (!link) throw new Error(`No magic link found in the email to ${email}`)
  return link
}

/**
 * Request a magic link from the current page's form (sign-in or sign-up) and wait for the
 * "check your email" state. The submit button label differs per page.
 */
export async function requestMagicLink(
  page: Page,
  email: string,
  options: { submit: string | RegExp; name?: string },
): Promise<string> {
  const previousId = await lastEmailId(email)
  if (options.name !== undefined) await page.getByLabel("Name").fill(options.name)
  await page.getByLabel("Email").fill(email)
  await page.getByRole("button", { name: options.submit }).click()
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible()
  return waitForMagicLink(email, previousId)
}

/** Sign up through /sign-up and open the magic link. Returns the link (single use). */
export async function signUp(page: Page, email: string, name?: string): Promise<string> {
  await page.goto("/sign-up")
  const link = await requestMagicLink(page, email, { submit: "Create account", name })
  await page.goto(link)
  return link
}

/** Sign in through /sign-in (optionally with a callbackUrl) and open the magic link. */
export async function signIn(page: Page, email: string, path = "/sign-in"): Promise<string> {
  await page.goto(path)
  const link = await requestMagicLink(page, email, { submit: "Email me a sign-in link" })
  await page.goto(link)
  return link
}

/** Choose a role on /onboarding/role and continue to the app. */
export async function chooseRole(page: Page, role: "creator" | "builder" | "both") {
  await expect(page).toHaveURL(/\/onboarding\/role$/)
  const title = { creator: "I'm a creator", builder: "I'm a builder", both: "Both" }[role]
  // The radio itself is visually hidden inside a card; click the card like a person would.
  await page.locator("label").filter({ hasText: title }).click()
  await expect(page.getByRole("radio", { name: new RegExp(`^${title}`) })).toBeChecked()
  await page.getByRole("button", { name: "Continue" }).click()
}

/** Sign out from the app shell's user menu (sidebar footer). */
export async function signOutFromApp(page: Page, accountLabel: string | RegExp) {
  await page.getByRole("button", { name: accountLabel }).click()
  await page.getByRole("menuitem", { name: "Sign out" }).click()
}
