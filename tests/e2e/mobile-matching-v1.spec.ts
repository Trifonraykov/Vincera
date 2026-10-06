import { expect, test } from "./fixtures"
import { signedInAdmin } from "./helpers/launches"

/**
 * `/admin/matching` on a phone (CLAUDE.md §19.20, §19.42): tables scroll inside their own boxes,
 * the page never scrolls sideways at 390 or 360 px, and the Train button is a 44 px target.
 */

test("the matching admin page fits a phone", async ({ browser, baseURL }) => {
  test.setTimeout(90_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const admin = await signedInAdmin(browser, baseURL, {
    viewport: { width: 390, height: 664 },
    hasTouch: true,
    isMobile: true,
  })
  for (const width of [390, 360]) {
    await admin.setViewportSize({ width, height: 664 })
    await admin.goto("/admin/matching")
    await expect(admin.getByRole("heading", { level: 1, name: "Matching" })).toBeVisible()
    await expect(admin.getByRole("table", { name: /Funnel by match score/ })).toBeVisible()
    const overflow = await admin.evaluate(() => {
      const root = document.scrollingElement
      return root ? root.scrollWidth - window.innerWidth : 0
    })
    expect(overflow).toBeLessThanOrEqual(0)
    const train = admin.getByRole("button", { name: "Train a v1 model" }).first()
    const box = await train.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
  await admin.context().close()
})
