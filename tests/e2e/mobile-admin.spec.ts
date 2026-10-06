import { expect, test } from "./fixtures"
import { signedInAdmin } from "./helpers/launches"

/**
 * The Phase 6 admin pages at phone width (CLAUDE.md §19.20, §19.39): each renders with its
 * heading, no sideways scroll at 390 and 360 px, filter chips with 44 px targets.
 */

const PAGES = [
  ["/admin", "Admin overview"],
  ["/admin/users", "Users"],
  ["/admin/collabs", "Collabs"],
  ["/admin/disputes", "Disputes"],
  ["/admin/payouts", "Payouts"],
  ["/admin/launches?tab=all", "Launches"],
  ["/admin/audit", "Audit log"],
] as const

test("the admin pages fit a phone", async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const page = await signedInAdmin(browser, baseURL, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 })
    for (const [path, heading] of PAGES) {
      await page.goto(path)
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible()
      const overflow = await page.evaluate(() => {
        const root = document.scrollingElement ?? document.documentElement
        return root.scrollWidth - window.innerWidth
      })
      expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(0)
    }
  }
  await page.goto("/admin/users")
  const chip = page.getByRole("navigation", { name: "Roles" }).getByRole("link").first()
  expect((await chip.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await page.context().close()
})
