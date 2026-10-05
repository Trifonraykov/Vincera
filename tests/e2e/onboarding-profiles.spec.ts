import { randomBytes } from "node:crypto"

import { newId } from "@/lib/ids"

import { expect, test } from "./fixtures"
import { uniqueEmail } from "./helpers/accounts"
import { chooseRole, signUp } from "./helpers/auth"
import { withE2eDb } from "./helpers/db"
import {
  addProject,
  fillBuilderProfile,
  fillCreatorProfile,
  TINY_PNG,
  uniqueHandle,
} from "./helpers/profiles"

/**
 * Phase 1 onboarding and settings pages (§12, §16; CLAUDE.md §19.15, §19.17): the role picker,
 * the profile forms (live handle check, validation that keeps what was typed, topics and skills
 * as tags, handles shared between roles), the optional steps put off with "Do this later", the
 * portfolio with an uploaded image, and Settings → Profile (tabs, edits persist) / Notifications /
 * Account (active role, sign out, GDPR placeholders). Social connections and payouts have their
 * own specs.
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

/** A handle owned by someone else (a user who exists only in the database). */
async function handleTakenBySomeoneElse(): Promise<string> {
  const handle = uniqueHandle("taken")
  await withE2eDb(async (pool) => {
    const id = newId()
    await pool.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [
      id,
      `other-${randomBytes(4).toString("hex")}@example.com`,
      "Someone Else",
    ])
    await pool.query("INSERT INTO handles (handle, user_id) VALUES ($1, $2)", [handle, id])
  })
  return handle
}

test.describe("onboarding profiles and settings", () => {
  test("creator: role → profile → connect later → review → payouts later → /app, then settings", async ({
    page,
  }) => {
    test.setTimeout(150_000)
    const email = uniqueEmail("onb-creator")
    await signUp(page, email, "Maya Maker")

    // The role cards explain each side.
    await expect(page).toHaveURL(/\/onboarding\/role$/)
    await expect(page.getByText("Post ideas your audience keeps asking for")).toBeVisible()
    await expect(page.getByText("List products that need an audience")).toBeVisible()
    await chooseRole(page, "creator")
    await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
    await expect(page.getByText("Step 2 of 5")).toBeVisible()

    // The handle is checked as it is typed: reserved words at once, availability after a pause.
    const handleInput = page.getByLabel("Handle")
    await handleInput.fill("settings")
    await expect(page.getByText("That handle is reserved. Try another.")).toBeVisible()
    await expect(handleInput).toHaveAttribute("aria-invalid", "true")

    // Invalid input comes back with plain-language errors, and what was typed is kept.
    await fillCreatorProfile(page, { name: "Maya Maker", handle: "no", niche: "Budget cooking" })
    await page.getByRole("button", { name: "Continue" }).click()
    // Wait for the server's answer, not the live hint (same words, already on screen): the
    // refused form puts back what was submitted, which would overwrite the handle typed next.
    await expect(handleInput).toHaveAttribute("aria-describedby", /-error\b/)
    await expect(page.getByText(/Use 3–30 lowercase letters, numbers or underscores/)).toBeVisible()
    await expect(handleInput).toHaveAttribute("aria-invalid", "true")
    await expect(page.getByLabel(/Your niche/)).toHaveValue("Budget cooking")

    const handle = uniqueHandle("maya")
    await handleInput.fill(`@${handle.toUpperCase()}`)
    await expect(page.getByText(`@${handle} is available.`)).toBeVisible()
    await expect(page.getByText(`/c/${handle}`)).toBeVisible()
    await fillCreatorProfile(page, {
      handle: `@${handle.toUpperCase()}`,
      bio: "Cheap, quick recipes for students.",
      country: "Spain",
      languages: ["Spanish", "English"],
      topics: ["Meal Prep", "#budget recipes"],
    })
    const addedTopics = page.getByRole("list", { name: "Added topics" })
    await expect(addedTopics.getByRole("listitem")).toHaveText(["meal prep", "budget recipes"])
    // Backspace in the empty box removes the last tag; the remove button does the same.
    await page.getByLabel(/^Topics/).press("Backspace")
    await expect(addedTopics.getByRole("listitem")).toHaveText(["meal prep"])
    await page.getByLabel(/^Topics/).fill("student food, ")
    await expect(addedTopics.getByRole("listitem")).toHaveText(["meal prep", "student food"])
    await page.getByRole("button", { name: "Continue" }).click()

    // Connect: nothing connected yet, so only "Do this later".
    await expect(page).toHaveURL(/\/onboarding\/creator\/connect$/)
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0)
    await page.getByRole("button", { name: "Do this later" }).click()

    // Review cannot be skipped: with no stats the creator writes the summary and continues.
    await expect(page).toHaveURL(/\/onboarding\/creator\/review$/)
    await expect(page.getByRole("button", { name: "Do this later" })).toHaveCount(0)
    await page
      .getByLabel("Audience summary")
      .fill("Students in Spain who want to eat well on a tight budget.")
    await page.getByRole("button", { name: "Continue" }).click()

    // Payouts: put off as well; onboarding is complete.
    await expect(page).toHaveURL(/\/onboarding\/payouts$/)
    await page.getByRole("button", { name: "Do this later" }).click()
    await expect(page).toHaveURL(/\/app$/)
    await expect(page.getByRole("heading", { name: "Creator home" })).toBeVisible()
    expect(await onboardingCompletedEvent(email)).toEqual([
      {
        properties: {
          roles: ["creator"],
          skipped_steps: ["creator.connect", "payouts"],
        },
      },
    ])

    // Going back to a finished step is allowed and shows the saved profile.
    await page.goto("/onboarding/creator/profile")
    await expect(page.getByRole("heading", { name: "Your creator profile" })).toBeVisible()
    await expect(page.getByLabel("Handle")).toHaveValue(handle)

    // Settings → Profile: the tabs, then rename the handle, change the niche and the topics.
    await page.goto("/app/settings/profile")
    const settingsNav = page.getByRole("navigation", { name: "Settings" })
    await expect(settingsNav.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "aria-current",
      "page",
    )
    for (const tab of ["Connections", "Payouts", "Notifications", "Account"]) {
      await expect(settingsNav.getByRole("link", { name: tab })).toBeVisible()
    }
    await expect(page.getByLabel(/Where you're based/)).toHaveValue("ES")
    await expect(page.getByRole("checkbox", { name: "Spanish", exact: true })).toBeChecked()
    await expect(page.getByLabel("Handle")).toHaveValue(handle)
    const renamed = uniqueHandle("maya_cooks")
    await fillCreatorProfile(page, {
      handle: renamed,
      niche: "Student cooking on a budget",
      topics: ["one pot meals"],
    })
    await page.getByRole("button", { name: "Remove topic meal prep" }).click()
    await page.getByRole("button", { name: "Save creator profile" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible()

    // The edits persist across a reload.
    await page.reload()
    await expect(page.getByLabel("Handle")).toHaveValue(renamed)
    await expect(page.getByLabel(/Your niche/)).toHaveValue("Student cooking on a budget")
    await expect(page.getByRole("list", { name: "Added topics" }).getByRole("listitem")).toHaveText(
      ["student food", "one pot meals"],
    )

    // The public profile follows the handle; the old address is gone.
    await page.goto(`/c/${renamed}`)
    await expect(page.getByRole("heading", { level: 1, name: "Maya Maker" })).toBeVisible()
    await expect(page.getByText("Student cooking on a budget")).toBeVisible()
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

    // Settings → Account: email read-only, GDPR actions announced but disabled, rename.
    await page.goto("/app/settings/account")
    await expect(page.getByRole("main").getByText(email.toLowerCase())).toBeVisible()
    await expect(page.getByRole("button", { name: "Export my data" })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Delete account" })).toBeDisabled()
    await expect(page.getByText(/Coming with the data-protection tools/).first()).toBeVisible()
    await expect(page.getByRole("link", { name: "Become a builder too" })).toHaveAttribute(
      "href",
      "/onboarding/role",
    )
    await page.getByLabel("Your name").fill("Maya M.")
    await page.getByRole("button", { name: "Save name" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible()

    // Sign out everywhere ends this session too.
    await page.getByRole("button", { name: "Sign out everywhere" }).click()
    await page
      .getByRole("dialog", { name: "Sign out on every device?" })
      .getByRole("button", { name: "Sign out everywhere" })
      .click()
    await expect(page).toHaveURL(/\/sign-in$/)
    await page.goto("/app")
    await expect(page).toHaveURL(/\/sign-in\?callbackUrl=%2Fapp$/)
  })

  test("builder: role → profile → portfolio with an image → payouts later → /app", async ({
    page,
  }) => {
    test.setTimeout(150_000)
    const taken = await handleTakenBySomeoneElse()
    const email = uniqueEmail("onb-builder")
    await signUp(page, email, "Ben Builder")
    await chooseRole(page, "builder")
    await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)

    // Someone else's handle is flagged before submitting, and refused on submit.
    await page.getByLabel("Handle").fill(taken)
    await expect(page.getByText("That handle is taken. Try another one.")).toBeVisible()
    await page.getByRole("button", { name: "Continue" }).click()
    // Wait for the server's answer, not the live hint (same words, already on screen): the
    // refused form puts back what was submitted, which would overwrite anything typed earlier.
    await expect(page.getByLabel("Handle")).toHaveAttribute("aria-describedby", /-error\b/)
    await expect(page.getByText("That handle is taken. Try another one.")).toBeVisible()
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

    // Portfolio: empty to start with, so only "Do this later"; GitHub links to the OAuth start.
    await expect(page).toHaveURL(/\/onboarding\/builder\/portfolio$/)
    await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Do this later" })).toBeVisible()
    await expect(
      page.getByRole("region", { name: "GitHub" }).getByRole("link", { name: "Connect GitHub" }),
    ).toHaveAttribute(
      "href",
      "/api/oauth/github/start?returnTo=%2Fonboarding%2Fbuilder%2Fportfolio",
    )

    // A bad link and a file that is not an allowed image are refused in the dialog.
    await page.getByRole("button", { name: "Add a project" }).click()
    const dialog = page.getByRole("dialog", { name: "Add a project" })
    await dialog.getByLabel("Title").fill("Broken link")
    await dialog.getByLabel(/^Link/).fill("javascript:alert(1)")
    await dialog.getByLabel("Choose image").setInputFiles({
      name: "logo.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    })
    await expect(dialog.getByText("Upload a PNG, JPEG, WebP or GIF image.")).toBeVisible()
    await dialog.getByRole("button", { name: "Add project" }).click()
    await expect(dialog.getByText("Enter a web address, like https://example.com.")).toBeVisible()
    await dialog.getByRole("button", { name: "Cancel" }).click()

    await addProject(page, {
      title: "Invoice generator",
      url: "invoices.example.com",
      description: "Invoices for freelancers in two clicks.",
      format: "Tool",
      shipped: true,
      image: TINY_PNG,
    })
    await addProject(page, { title: "Recipe planner", format: "App" })
    const projects = page.getByRole("list", { name: "Your projects" })
    await expect(projects.getByRole("listitem")).toHaveCount(2)
    await expect(projects).toContainText("invoices.example.com")
    await expect(projects).toContainText("Shipped")

    // The uploaded image is served (through the image route's signed redirect) and shown.
    const thumbnail = projects.getByRole("listitem").filter({ hasText: "Invoice generator" })
    const image = thumbnail.locator("img")
    await expect(image).toHaveAttribute("src", /^\/api\/portfolio\/[0-9a-f-]+\/image\?v=/)
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0)

    // Edit one (removing its image), remove the other.
    await projects.getByRole("button", { name: "Edit Invoice generator" }).click()
    const edit = page.getByRole("dialog", { name: "Edit project" })
    await expect(edit.getByRole("img", { name: "Image of Invoice generator" })).toBeVisible()
    await edit.getByRole("button", { name: "Remove image" }).click()
    await edit.getByRole("button", { name: "Save project" }).click()
    await expect(edit).toBeHidden()
    await expect(thumbnail.locator("img")).toHaveCount(0)

    await projects.getByRole("button", { name: "Edit Recipe planner" }).click()
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

    // A project lets the builder continue; payouts are put off.
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(page).toHaveURL(/\/onboarding\/payouts$/)
    await page.getByRole("button", { name: "Do this later" }).click()
    await expect(page).toHaveURL(/\/app$/)
    await expect(page.getByRole("heading", { name: "Builder home" })).toBeVisible()

    // The public profile shows the profile, its tags and the project.
    await page.goto(`/b/${handle}`)
    await expect(page.getByRole("heading", { level: 1, name: "Ben Builder" })).toBeVisible()
    await expect(page.getByText("Limited availability")).toBeVisible()
    await expect(page.getByRole("heading", { name: "Invoice generator" })).toBeVisible()
    await expect(page.getByText("TypeScript", { exact: true })).toBeVisible()

    // Settings → Profile: skills edited as tags persist.
    await page.goto("/app/settings/profile")
    const skills = page.getByRole("list", { name: "Added skills" })
    await expect(skills.getByRole("listitem")).toHaveText(["Web apps", "AI tools"])
    await page.getByRole("button", { name: "Remove skill AI tools" }).click()
    await page.getByLabel(/^Skills/).fill("Chrome extensions")
    await page.getByLabel(/^Skills/).press("Enter")
    await page.getByRole("button", { name: "Save builder profile" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("list", { name: "Added skills" }).getByRole("listitem")).toHaveText(
      ["Web apps", "Chrome extensions"],
    )
  })

  test("both roles: creator steps first, a shared handle, profile tabs and the active role", async ({
    page,
  }) => {
    test.setTimeout(150_000)
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

    // The builder profile starts from the creator profile: same name and handle, which is theirs.
    await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)
    await expect(page.getByLabel("Handle")).toHaveValue(handle)
    await expect(page.getByText(/use one handle for both/)).toBeVisible()
    await page.getByLabel("Handle").fill(`@${handle.toUpperCase()}`)
    await expect(page.getByText("This handle is yours.")).toBeVisible()
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

    // Settings → Profile: one tab per profile, the active role (creator) first.
    await page.goto("/app/settings/profile")
    const tabs = page.getByRole("tablist", { name: "Your profiles" })
    await expect(tabs.getByRole("tab")).toHaveText(["Creator profile", "Builder profile"])
    await expect(tabs.getByRole("tab", { name: "Creator profile" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    const creatorPanel = page.getByRole("tabpanel", { name: "Creator profile" })
    await expect(creatorPanel.getByLabel(/Your niche/)).toHaveValue("Indie game dev")
    await tabs.getByRole("tab", { name: "Builder profile" }).click()
    const builderPanel = page.getByRole("tabpanel", { name: "Builder profile" })
    await expect(
      builderPanel.getByRole("list", { name: "Added tools" }).getByRole("listitem"),
    ).toHaveText(["Godot", "C#"])
    // The radios are visually hidden inside cards; click the card like a person would.
    await builderPanel.locator("label").filter({ hasText: "Not taking new collabs" }).click()
    await builderPanel.getByRole("button", { name: "Save builder profile" }).click()
    await expect(builderPanel.getByRole("status").filter({ hasText: "Saved." })).toBeVisible()
    await page.goto("/app/settings/profile?tab=builder")
    await expect(page.getByRole("tab", { name: "Builder profile" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    await expect(
      page.getByRole("tabpanel", { name: "Builder profile" }).getByRole("radio", {
        name: /Not taking new collabs/,
      }),
    ).toBeChecked()

    // Settings → Account: switch the active role; the home follows.
    await page.goto("/app/settings/account")
    const roles = page.getByRole("list", { name: "Your roles" })
    await expect(roles.getByText("Active")).toHaveCount(1)
    await roles.getByRole("button", { name: "Use as builder" }).click()
    await expect(roles.getByRole("button", { name: "Use as creator" })).toBeVisible()
    await page.goto("/app")
    await expect(page.getByRole("heading", { name: "Builder home" })).toBeVisible()

    // The role page has nothing left to add; sign out (this device) works from Account.
    await page.goto("/onboarding/role")
    await expect(
      page.getByRole("heading", { name: "You're a creator and a builder" }),
    ).toBeVisible()
    await page.goto("/app/settings/account")
    await page.getByRole("button", { name: "Sign out", exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    await page.goto("/app")
    await expect(page).toHaveURL(/\/sign-in\?callbackUrl=%2Fapp$/)
  })
})
