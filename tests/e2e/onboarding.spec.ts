import { expect, test } from "./fixtures"
import { uniqueEmail } from "./helpers/accounts"
import { chooseRole, signUp } from "./helpers/auth"
import { withE2eDb } from "./helpers/db"
import {
  addProject,
  fillBuilderProfile,
  fillCreatorProfile,
  uniqueHandle,
} from "./helpers/profiles"

/**
 * Phase 1 onboarding and settings pages (§12, §16): the profile forms (validation, handles shared
 * between roles), the optional steps put off with "Do this later", the portfolio, and Settings →
 * Profile / Notifications / Account. Social connections and payouts have their own specs.
 */

async function onboardingCompletedEvent(email: string) {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ properties: { roles: string[]; skipped_steps: string[] } }>(
      `SELECT e.properties FROM events e JOIN users u ON u.id = e.subject_id
       WHERE u.email = $1 AND e.type = 'onboarding.completed'`,
      [email.toLowerCase()],
    )
    return rows
  })
}

test.describe("onboarding and settings", () => {
  test("a creator fills the profile, puts off the optional steps and edits it in settings", async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const email = uniqueEmail("onb-creator")
    await signUp(page, email, "Maya Maker")
    await chooseRole(page, "creator")
    await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
    await expect(page.getByText("Step 2 of 5")).toBeVisible()

    // Invalid input comes back with plain-language errors, and what was typed is kept.
    await fillCreatorProfile(page, { name: "Maya Maker", handle: "no", niche: "Budget cooking" })
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(page.getByText(/Use 3–30 lowercase letters, numbers or underscores/)).toBeVisible()
    await expect(page.getByLabel("Handle")).toHaveAttribute("aria-invalid", "true")
    await expect(page.getByLabel(/Your niche/)).toHaveValue("Budget cooking")

    const handle = uniqueHandle("maya")
    await fillCreatorProfile(page, {
      handle: `@${handle.toUpperCase()}`,
      bio: "Cheap, quick recipes for students.",
      country: "Spain",
      languages: ["Spanish", "English"],
    })
    await page.getByRole("button", { name: "Continue" }).click()

    // Connect: nothing connected yet, so only "Do this later".
    await expect(page).toHaveURL(/\/onboarding\/creator\/connect$/)
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0)
    await page.getByRole("button", { name: "Do this later" }).click()

    // Review: no stats, so the creator writes the summary.
    await expect(page).toHaveURL(/\/onboarding\/creator\/review$/)
    await expect(page.getByText(/haven't connected an account yet/)).toBeVisible()
    await page
      .getByLabel("Audience summary")
      .fill("Students in Spain who want to eat well on a tight budget.")
    await page.getByLabel("Topics").fill("budget recipes, meal prep")
    await page.getByRole("button", { name: "Continue" }).click()

    // Payouts: put off as well; onboarding is complete.
    await expect(page).toHaveURL(/\/onboarding\/payouts$/)
    await page.getByRole("button", { name: "Do this later" }).click()
    await expect(page).toHaveURL(/\/app$/)
    await expect(page.getByRole("heading", { name: "Creator home" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Connect your audience" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Set up payouts" })).toBeVisible()
    expect(await onboardingCompletedEvent(email)).toEqual([
      {
        properties: {
          roles: ["creator"],
          skipped_steps: ["creator.connect", "payouts"],
        },
      },
    ])

    // Going back to a finished step is allowed; the progress links to it.
    await page.goto("/onboarding/creator/profile")
    await expect(page.getByRole("heading", { name: "Your creator profile" })).toBeVisible()
    await expect(page.getByLabel("Handle")).toHaveValue(handle)

    // Settings → Profile: the tabs, then rename the handle and change the niche.
    await page.goto("/app/settings/profile")
    const settingsNav = page.getByRole("navigation", { name: "Settings" })
    await expect(settingsNav.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "aria-current",
      "page",
    )
    await expect(page.getByLabel(/Where you're based/)).toHaveValue("ES")
    await expect(page.getByRole("checkbox", { name: "Spanish", exact: true })).toBeChecked()
    const renamed = uniqueHandle("maya_cooks")
    await fillCreatorProfile(page, { handle: renamed, niche: "Student cooking on a budget" })
    await page.getByRole("button", { name: "Save creator profile" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible()
    await expect(page.getByLabel("Handle")).toHaveValue(renamed)

    // The public profile follows the handle; the old address is gone.
    await page.goto(`/c/${renamed}`)
    await expect(page.getByRole("heading", { level: 1, name: "Maya Maker" })).toBeVisible()
    await expect(page.getByText("Student cooking on a budget")).toBeVisible()
    // Languages are stored in list order, whatever order they were ticked in.
    await expect(page.getByText(/English, Spanish/)).toBeVisible()
    expect((await page.goto(`/c/${handle}`))?.status()).toBe(404)

    // Settings → Notifications: switch off an email.
    await page.goto("/app/settings/notifications")
    const expiredEmail = page
      .getByRole("group", { name: "A connected account needs to be reconnected" })
      .getByRole("checkbox", { name: "Email" })
    await expect(expiredEmail).toBeChecked()
    await expiredEmail.uncheck()
    await page.getByRole("button", { name: "Save preferences" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible()
    await page.reload()
    await expect(expiredEmail).not.toBeChecked()

    // Settings → Account: rename, then sign out everywhere.
    await page.goto("/app/settings/account")
    await expect(page.getByRole("main").getByText(email.toLowerCase())).toBeVisible()
    await page.getByLabel("Your name").fill("Maya M.")
    await page.getByRole("button", { name: "Save name" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible()
    await page.getByRole("button", { name: "Sign out everywhere" }).click()
    await page
      .getByRole("dialog", { name: "Sign out on every device?" })
      .getByRole("button", { name: "Sign out everywhere" })
      .click()
    await expect(page).toHaveURL(/\/sign-in$/)
    await page.goto("/app")
    await expect(page).toHaveURL(/\/sign-in\?callbackUrl=%2Fapp$/)
  })

  test("a builder adds, edits and removes projects, then finishes onboarding", async ({ page }) => {
    test.setTimeout(120_000)
    const email = uniqueEmail("onb-builder")
    await signUp(page, email, "Ben Builder")
    await chooseRole(page, "builder")
    await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)

    const handle = uniqueHandle("ben")
    await fillBuilderProfile(page, {
      handle,
      bio: "Small tools for creators.",
      skills: "Web apps, AI tools",
      stack: "TypeScript, Postgres",
      availability: "Limited availability",
      dealPreference: "Fixed fee",
    })
    await page.getByRole("button", { name: "Continue" }).click()

    // Portfolio: empty to start with, so only "Do this later".
    await expect(page).toHaveURL(/\/onboarding\/builder\/portfolio$/)
    await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Do this later" })).toBeVisible()

    // A bad link is refused in the dialog.
    await page.getByRole("button", { name: "Add a project" }).click()
    const dialog = page.getByRole("dialog", { name: "Add a project" })
    await dialog.getByLabel("Title").fill("Broken link")
    await dialog.getByLabel(/^Link/).fill("javascript:alert(1)")
    await dialog.getByRole("button", { name: "Add project" }).click()
    await expect(dialog.getByText("Enter a web address, like https://example.com.")).toBeVisible()
    await dialog.getByRole("button", { name: "Cancel" }).click()

    await addProject(page, {
      title: "Invoice generator",
      url: "invoices.example.com",
      description: "Invoices for freelancers in two clicks.",
      format: "Tool",
      shipped: true,
    })
    await addProject(page, { title: "Recipe planner", format: "App" })
    const projects = page.getByRole("list", { name: "Your projects" })
    await expect(projects.getByRole("listitem")).toHaveCount(2)
    await expect(projects).toContainText("invoices.example.com")
    await expect(projects).toContainText("Shipped")

    // Edit one, remove the other.
    await projects.getByRole("button", { name: "Edit Recipe planner" }).click()
    const edit = page.getByRole("dialog", { name: "Edit project" })
    await edit.getByLabel("Title").fill("Meal planner")
    await edit.getByRole("button", { name: "Save project" }).click()
    await expect(edit).toBeHidden()
    await expect(projects).toContainText("Meal planner")
    await projects.getByRole("button", { name: "Remove Meal planner" }).click()
    await page
      .getByRole("dialog", { name: /Remove “Meal planner”/ })
      .getByRole("button", { name: "Remove project" })
      .click()
    await expect(projects.getByRole("listitem")).toHaveCount(1)

    // A project lets the builder continue.
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(page).toHaveURL(/\/onboarding\/payouts$/)
    await page.getByRole("button", { name: "Do this later" }).click()
    await expect(page).toHaveURL(/\/app$/)
    await expect(page.getByRole("heading", { name: "Builder home" })).toBeVisible()

    // The public profile shows the profile and the project.
    await page.goto(`/b/${handle}`)
    await expect(page.getByRole("heading", { level: 1, name: "Ben Builder" })).toBeVisible()
    await expect(page.getByText("Limited availability")).toBeVisible()
    await expect(page.getByRole("heading", { name: "Invoice generator" })).toBeVisible()
    await expect(page.getByText("TypeScript", { exact: true })).toBeVisible()
  })

  test("both roles: creator steps first, then the builder profile shares the handle", async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const email = uniqueEmail("onb-both")
    await signUp(page, email, "Sam Both")
    await chooseRole(page, "both")
    await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
    await expect(page.getByText("Step 2 of 7")).toBeVisible()

    const handle = uniqueHandle("sam")
    await fillCreatorProfile(page, { handle, niche: "Indie game dev" })
    await page.getByRole("button", { name: "Continue" }).click()
    await page.getByRole("button", { name: "Do this later" }).click()
    await expect(page).toHaveURL(/\/onboarding\/creator\/review$/)
    await page.getByRole("button", { name: "Continue" }).click()

    // The builder profile starts from the creator profile: same name and handle.
    await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)
    await expect(page.getByLabel("Handle")).toHaveValue(handle)
    await expect(page.getByText(/use one handle for both/)).toBeVisible()
    await fillBuilderProfile(page, { handle, stack: "Godot, C#" })
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(page).toHaveURL(/\/onboarding\/builder\/portfolio$/)
    await page.getByRole("button", { name: "Do this later" }).click()
    await expect(page).toHaveURL(/\/onboarding\/payouts$/)
    await page.getByRole("button", { name: "Do this later" }).click()
    await expect(page).toHaveURL(/\/app$/)

    // One handle, two public pages.
    await page.goto(`/c/${handle}`)
    await expect(page.getByRole("heading", { level: 1, name: "Sam Both" })).toBeVisible()
    await page.goto(`/b/${handle}`)
    await expect(page.getByRole("heading", { level: 1, name: "Sam Both" })).toBeVisible()

    // Settings shows both profiles; the role page has nothing left to add.
    await page.goto("/app/settings/profile")
    await expect(page.getByRole("heading", { name: "Creator profile" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Builder profile" })).toBeVisible()
    await page.goto("/onboarding/role")
    await expect(
      page.getByRole("heading", { name: "You're a creator and a builder" }),
    ).toBeVisible()
  })
})
