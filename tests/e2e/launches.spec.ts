import type { Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import {
  clickCount,
  insertBuildingCollab,
  launchEventTypes,
  launchState,
  signedInAdmin,
} from "./helpers/launches"
import { newPerson } from "./helpers/proposals"

/**
 * §16 Phase 4, launch side (CLAUDE.md §19.32), on the desktop layout: a signed collab sets up its
 * launch, both members approve, an admin approves it in review, the product page `/p/<slug>` is
 * live with "by @creator × @builder", and the creator's tracked link `/r/<code>` logs the click,
 * sets the attribution cookie and lands on the product page. (Checkout is the checkout builder's.)
 */

async function approve(page: Page, collabId: string, expected: string) {
  await page.goto(`/app/collabs/${collabId}/launch`)
  await page.getByRole("button", { name: "Approve this version" }).click()
  await expect(page.getByText(expected, { exact: true }).first()).toBeVisible()
}

test("both members approve, an admin approves, the page goes live and the link attributes", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const creator = await newPerson(browser, { role: "creator", name: "Lia Launcher", baseURL })
  const builder = await newPerson(browser, { role: "builder", name: "Max Maker", baseURL })
  const title = "Plant care planner"
  const collabId = await insertBuildingCollab(creator.userId, builder.userId, title)
  const slug = `plant-care-${Date.now().toString(36)}`

  // --- The creator starts and fills in the launch ------------------------------------------------
  const c = creator.page
  await c.goto(`/app/collabs/${collabId}`)
  await c
    .getByRole("navigation", { name: "Collab sections" })
    .getByRole("link", { name: "Launch" })
    .click()
  await expect(c).toHaveURL(new RegExp(`/app/collabs/${collabId}/launch$`))
  await c.getByRole("button", { name: "Set up the launch" }).click()
  await expect(c.getByLabel("Title")).toHaveValue(title)
  await c.getByLabel("Tagline").fill("Never forget to water again")
  await c.getByLabel("Page address").fill(slug)
  await c.getByLabel("Description").fill("A **weekly plan** for every plant in your home.")
  await c.getByLabel("Price").fill("19")
  await c.locator("label").filter({ hasText: "A link" }).click()
  await c.getByLabel("Link buyers are sent to").fill("https://plants.example.com/welcome")
  await c.getByRole("button", { name: "Save launch" }).click()
  await expect(c.getByText("Saved.", { exact: true })).toBeVisible()

  // --- Both approve: the launch goes to review ---------------------------------------------------
  await approve(c, collabId, "Waiting for approval")
  expect(await launchState(collabId)).toMatchObject({
    status: "pending_approval",
    stage: "launch_review",
  })
  await approve(builder.page, collabId, "In review")
  expect(await launchState(collabId)).toMatchObject({ status: "admin_review" })

  // --- The admin approves it: live, with the creator's default tracked link ----------------------
  const admin = await signedInAdmin(browser, baseURL)
  await admin.goto("/admin/launches")
  const card = admin.getByRole("article", { name: title })
  await expect(card).toBeVisible()
  await card.getByRole("button", { name: "Approve and go live" }).click()
  await expect(card).toHaveCount(0)
  const state = await launchState(collabId)
  expect(state).toMatchObject({ status: "live", stage: "live", slug })
  expect(state?.link_code).toMatch(/^[0-9A-Za-z]{8}$/)
  expect(await launchEventTypes(state?.id ?? "")).toEqual(
    expect.arrayContaining([
      "launch.created",
      "launch.submitted",
      "launch.approved",
      "launch.live",
    ]),
  )

  // The members see it live, with the tracked link and the kit.
  await c.goto(`/app/collabs/${collabId}/launch`)
  await expect(c.getByText("Live", { exact: true }).first()).toBeVisible()
  await expect(c.getByText(`/r/${state?.link_code}`)).toBeVisible()
  await c.getByRole("link", { name: "Launch kit" }).click()
  await expect(c).toHaveURL(/\/app\/launches\/[0-9a-f-]{36}\/kit$/)
  await c.getByRole("button", { name: "Write posts" }).click()
  await expect(c.getByRole("heading", { name: "YouTube" })).toBeVisible()
  await expect(c.getByText(`/r/${state?.link_code}`).first()).toBeVisible()

  // --- A buyer follows the tracked link: logged, cookie set, product page live -------------------
  const visitor = await browser.newContext({ baseURL })
  const buyer = await visitor.newPage()
  await buyer.goto(`/r/${state?.link_code}`)
  await expect(buyer).toHaveURL(new RegExp(`/p/${slug}\\?ref=${state?.link_code}$`))
  await expect(buyer.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await expect(buyer.getByText(/by @\w+ × @\w+/)).toBeVisible()
  await expect(buyer.getByRole("button", { name: "Buy for €19.00" })).toBeVisible()
  await expect(
    buyer.getByText("Price includes VAT where it applies.", { exact: false }),
  ).toBeVisible()
  const cookies = await visitor.cookies()
  expect(cookies.find((cookie) => cookie.name === "attr")).toMatchObject({
    value: state?.link_id,
    httpOnly: true,
    sameSite: "Lax",
  })
  expect(await clickCount(state?.link_id ?? "")).toBe(1)

  // An unknown code is a 404 page.
  const missing = await buyer.goto("/r/Zz9Zz9Zz")
  expect(missing?.status()).toBe(404)

  // Pausing makes the page say it's unavailable.
  await c.goto(`/app/collabs/${collabId}/launch`)
  await c.getByRole("button", { name: "Pause sales" }).click()
  await c.getByRole("dialog").getByRole("button", { name: "Pause sales" }).click()
  await expect(c.getByText("Paused", { exact: true }).first()).toBeVisible()
  await buyer.goto(`/p/${slug}`)
  await expect(buyer.getByText("Not available right now")).toBeVisible()

  for (const page of [c, builder.page, admin, buyer]) await page.context().close()
})

test("people outside the collab cannot see its launch", async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error("baseURL is not set")
  const creator = await newPerson(browser, { role: "creator", name: "Oda Owner", baseURL })
  const builder = await newPerson(browser, { role: "builder", name: "Ben Builder", baseURL })
  const stranger = await newPerson(browser, { role: "creator", name: "Sam Stranger", baseURL })
  const collabId = await insertBuildingCollab(creator.userId, builder.userId, "Private planner")
  const response = await stranger.page.goto(`/app/collabs/${collabId}/launch`)
  expect(response?.status()).toBe(404)
  for (const person of [creator, builder, stranger]) await person.page.context().close()
})
