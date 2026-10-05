import { expect, test } from "./fixtures"
import { uniqueEmail } from "./helpers/accounts"
import { chooseRole, signUp } from "./helpers/auth"
import { completeOnboardingInDb } from "./helpers/db"

/**
 * The phone shell must leave the desktop alone (runs in the desktop "chromium" project, next to
 * the "mobile" project's specs): the sidebar and its header stay, there is no tab bar or phone
 * app bar, and the Me page works as an ordinary page.
 */

test("desktop keeps the sidebar; the phone tab bar and app bar stay hidden", async ({ page }) => {
  test.setTimeout(60_000)
  const email = uniqueEmail("desktop")
  await signUp(page, email, "Dee Desktop")
  await chooseRole(page, "creator")
  await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
  await completeOnboardingInDb(email)

  await page.goto("/app")
  await expect(page.getByRole("heading", { level: 1, name: "Creator home" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Toggle Sidebar" }).first()).toBeVisible()
  const sidebar = page.locator('[data-slot="sidebar"]')
  await expect(sidebar.getByRole("link", { name: "Audience" })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: "Discover (coming soon)" })).toBeDisabled()
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden()
  await expect(page.locator("[data-app-bar]")).toBeHidden()

  await sidebar.getByRole("link", { name: "Audience" }).click()
  await expect(page).toHaveURL(/\/app\/audience$/)
  await expect(sidebar.getByRole("link", { name: "Audience" })).toHaveAttribute(
    "aria-current",
    "page",
  )

  // Me is a phone tab, but the page also works on a desktop.
  await page.goto("/app/me")
  await expect(page.getByRole("heading", { level: 1, name: "Dee Desktop" })).toBeVisible()
  await expect(sidebar).toBeVisible()
})
