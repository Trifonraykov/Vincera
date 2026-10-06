import { expect, test } from "./fixtures"
import { addTopics, embeddedAt, eventsAbout, idFromUrl, onboardedUser } from "./helpers/supply"

/**
 * Phase 2 supply (§12 `/app/ideas/*`, `/app/products/*`; CLAUDE.md §19.25), on desktop: a creator
 * drafts an idea from audience comments with the AI brief drafter and publishes it, edits,
 * archives and restores it; a builder lists a product, is told what publishing needs, and
 * publishes it. The events, the AI review and the embedding are checked in the database.
 */

const COMMENTS = [
  "Can you make a budget template for students? I never know where my money goes",
  "please make a budget spreadsheet, I'm broke by the 20th",
  "a budget template for students would be amazing",
].join("\n")

test("a creator drafts an idea from comments, publishes, edits, archives and restores it", async ({
  page,
}) => {
  test.setTimeout(120_000)
  await onboardedUser(page, "creator", "ideas", "Ida Idea")

  await page.goto("/app/ideas")
  await expect(page.getByRole("heading", { level: 1, name: "Ideas" })).toBeVisible()
  await expect(page.getByText("Post your first idea")).toBeVisible()
  await page.getByRole("main").getByRole("link", { name: "New idea" }).first().click()
  await expect(page).toHaveURL(/\/app\/ideas\/new$/)

  // The brief drafter fills the form from pasted comments.
  await page.getByLabel("Audience comments").fill(COMMENTS)
  await page.getByRole("button", { name: "Draft my idea" }).click()
  await expect(page.getByText("Drafted from your comments.")).toBeVisible()
  await expect(page.getByLabel("Title")).toHaveValue("Budget template for students")
  await expect(page.getByLabel("Format")).toHaveValue("template")
  await expect(page.getByLabel(/^Target price/)).toHaveValue("19")
  await expect(page.getByLabel(/^Problem/)).not.toHaveValue("")

  // Publish it as drafted.
  await page.getByRole("button", { name: "Publish" }).click()
  await expect(page).toHaveURL(/\/app\/ideas\/[0-9a-f-]{36}\?saved=published$/)
  await expect(page.getByText("Published. Builders can find your idea")).toBeVisible()
  const status = page.getByRole("region", { name: "Status" })
  await expect(status.getByText("Open", { exact: true })).toBeVisible()
  const ideaId = idFromUrl(page.url())

  await expect
    .poll(async () => (await eventsAbout(ideaId)).map((event) => event.type))
    .toEqual(["idea.created", "idea.published", "ai.reviewed"])
  const reviewed = (await eventsAbout(ideaId)).find((event) => event.type === "ai.reviewed")
  expect(reviewed?.properties).toMatchObject({
    use: "idea_brief",
    accepted: true,
    edited: false,
  })
  // The embeddings job ran after the response.
  await expect.poll(() => embeddedAt("ideas", ideaId)).not.toBeNull()

  // Edit the published idea.
  await page.getByLabel("Title").fill("Budget template for uni students")
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel("Title")).toHaveValue("Budget template for uni students")

  // Archive (with a confirmation), then restore as a draft.
  await page.getByRole("button", { name: "Archive idea" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("Archive “Budget template for uni students”?")
  await dialog.getByRole("button", { name: "Archive", exact: true }).click()
  await expect(status.getByText("Archived", { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Problem" })).toBeVisible()
  await page.getByRole("button", { name: "Restore as draft" }).click()
  await expect(status.getByText("Draft", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Publish" })).toBeVisible()

  await expect
    .poll(async () => (await eventsAbout(ideaId)).map((event) => event.type))
    .toEqual([
      "idea.created",
      "idea.published",
      "ai.reviewed",
      "idea.updated",
      "idea.archived",
      "idea.restored",
    ])

  // The list shows it under Drafts.
  await page.goto("/app/ideas?status=draft")
  await expect(page.getByRole("link", { name: /Budget template for uni students/ })).toBeVisible()
  await expect(
    page.getByRole("navigation", { name: "Filter ideas by status" }).getByRole("link", {
      name: /Drafts/,
    }),
  ).toHaveAttribute("aria-current", "page")
})

test("a builder lists a product, is told what publishing needs, and publishes it", async ({
  page,
}) => {
  test.setTimeout(120_000)
  await onboardedUser(page, "builder", "products", "Bob Builder")

  await page.goto("/app/products")
  await expect(page.getByText("List your first product")).toBeVisible()
  await page.goto("/app/products/new")

  await page.getByLabel("Title").fill("Invoice generator")
  await page.locator("label").filter({ hasText: "Prototype" }).click()
  await page.getByLabel("Format").selectOption({ label: "Tool" })
  await page.getByLabel(/^Planned price/).fill("29,50")
  await page.getByLabel(/^Demo link/).fill("demo.example.com")

  // Publishing needs a description and a topic: the form says so next to the fields.
  await page.getByRole("button", { name: "Publish" }).click()
  await expect(page.getByText("Describe the product before publishing.")).toBeVisible()
  await expect(page.getByText(/Add at least one topic before publishing/)).toBeVisible()
  await expect(page.getByLabel("Title")).toHaveValue("Invoice generator")

  await page.getByLabel(/^Description/).fill("Creates **PDF invoices** in two clicks.")
  await addTopics(page, ["freelancing", "Invoicing"])
  await page.getByLabel(/Exclusive to one creator/).check()
  await page.getByRole("button", { name: "Save draft" }).click()
  await expect(page).toHaveURL(/\/app\/products\/[0-9a-f-]{36}\?saved=created$/)
  await expect(page.getByText("Saved as a draft.")).toBeVisible()
  const productId = idFromUrl(page.url())
  await expect(page.getByLabel(/^Planned price/)).toHaveValue("29.50")
  await expect(page.getByLabel(/^Demo link/)).toHaveValue("https://demo.example.com/")
  await expect(page.getByLabel(/Exclusive to one creator/)).toBeChecked()

  await page.getByRole("button", { name: "Publish" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Published." })).toBeVisible()
  await expect(
    page.getByRole("region", { name: "Status" }).getByText("Seeking creators", { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible()

  await expect
    .poll(async () => (await eventsAbout(productId)).map((event) => event.type))
    .toEqual(["product.created", "product.published"])
  const [created] = await eventsAbout(productId)
  expect(created?.properties).toEqual({
    format: "tool",
    stage: "prototype",
    topics: ["freelancing", "invoicing"],
    target_price_cents: 2950,
  })
  await expect.poll(() => embeddedAt("products", productId)).not.toBeNull()

  await page.goto("/app/products")
  const card = page.getByRole("link", { name: /Invoice generator/ })
  await expect(card).toContainText("Seeking creators")
  await expect(card).toContainText("Tool · Prototype · €29.50 · Exclusive")
})
