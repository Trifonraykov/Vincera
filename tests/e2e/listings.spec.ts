import { expect, test } from "./fixtures"
import { seededCreator, signInSeeded } from "./helpers/discover"
import { withE2eDb } from "./helpers/db"
import { newPerson } from "./helpers/proposals"

/**
 * Imported listings and the creator feed on desktop (CLAUDE.md §19.45): a builder imports their
 * App Store apps (the fake App Store's Tiny Forge Studio) and a product page (the fake web's
 * TaskTide), sees them listed as unverified, and a creator finds them in the feed, saves one and
 * opens it to send a proposal.
 */

test("a builder imports apps and a web page; a creator finds them in the feed", async ({
  browser,
  page,
  baseURL,
}) => {
  test.setTimeout(180_000)
  const builder = await newPerson(browser, {
    role: "builder",
    name: "Forge Builder",
    baseURL: baseURL ?? "",
  })
  const b = builder.page
  await b.goto("/app/products")

  const appStore = b.getByTestId("app-store-import")
  await appStore.getByLabel("Developer link or id").fill("not a link")
  await appStore.getByRole("button", { name: "Import my apps" }).click()
  await expect(appStore.getByText(/Paste a link from apps\.apple\.com/)).toBeVisible()

  await appStore
    .getByLabel("Developer link or id")
    .fill("https://apps.apple.com/us/developer/tiny-forge-studio/id1500000002")
  await appStore.getByRole("button", { name: "Import my apps" }).click()
  await expect(appStore.getByText("Tiny Forge Studio")).toBeVisible({ timeout: 30_000 })
  await expect(appStore.getByText("Unverified")).toBeVisible()
  await expect(appStore.getByText(/^VNC-/)).toBeVisible()

  const web = b.getByTestId("web-import")
  await web.getByLabel("Product page").fill("http://169.254.169.254/latest/meta-data/")
  await web.getByRole("button", { name: "Import" }).click()
  await expect(web.getByText(/isn't on the public internet/)).toBeVisible()
  await web.getByLabel("Product page").fill("go.tasktide.example")
  await web.getByRole("button", { name: "Import" }).click()

  const imported = b.getByRole("region", { name: "Imported listings" })
  await expect(imported.getByRole("link", { name: /TaskTide/ })).toBeVisible({ timeout: 30_000 })
  await expect(imported.getByRole("link", { name: /Recipe Box/ })).toBeVisible()

  // The builder's public page shows the grid.
  const handle = await withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ handle: string }>(
      "SELECT handle FROM builder_profiles WHERE user_id = $1",
      [builder.userId],
    )
    return rows[0]?.handle ?? ""
  })
  await b.goto(`/b/${handle}`)
  await expect(b.getByRole("heading", { name: "Products" })).toBeVisible()
  await expect(b.getByRole("link", { name: /Word Sprint/ })).toBeVisible()

  // A creator scrolls the feed.
  await signInSeeded(page, seededCreator(7))
  await page.goto("/app/feed")
  await expect(page.getByRole("heading", { level: 1, name: "For you" })).toBeVisible()
  const feed = page.getByRole("list", { name: "Products for you" })
  await expect(feed.getByRole("article").first()).toBeVisible()
  // The new builder's own copy of the app (seed builder 06 lists the same developer).
  const card = feed.getByRole("article", { name: /Word Sprint/ }).filter({ hasText: `@${handle}` })
  await expect(async () => {
    await page.mouse.wheel(0, 4000)
    await expect(card).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 60_000 })
  await card.scrollIntoViewIfNeeded()
  await expect(card).toBeVisible()
  const heart = card.getByRole("button", { name: /^Save Word Sprint/ })
  await heart.click()
  await expect(card.getByRole("button", { name: /^Saved: Word Sprint/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  )

  await card.getByRole("link", { name: /Open Word Sprint/ }).click()
  await expect(page).toHaveURL(/\/app\/feed\/[0-9a-f-]{36}/)
  await expect(page.getByRole("heading", { level: 1, name: /Word Sprint/ })).toBeVisible()
  await expect(page.getByRole("region", { name: /Screenshots of Word Sprint/ })).toBeVisible()
  await expect(page.getByText("Unverified")).toBeVisible()
  const propose = page.getByRole("link", { name: "Send a proposal" }).first()
  await expect(propose).toHaveAttribute("href", /\/app\/proposals\/new\?to=.+&product=/)

  // Saved shows up under Discover → Saved.
  await page.goto("/app/discover/saved")
  await expect(page.getByText(/Word Sprint/).first()).toBeVisible()
})
