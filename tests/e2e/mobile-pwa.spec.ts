import { expect, test } from "./fixtures"
import { uniqueEmail } from "./helpers/accounts"
import { chooseRole, signIn, signUp } from "./helpers/auth"
import { completeOnboardingInDb } from "./helpers/db"

/**
 * The installable app (CLAUDE.md §19, "Mobile app (PWA) patterns"): the manifest and icons, the
 * service worker's headers, offline fallback and caching rules (never a signed-in page), and the
 * "Install the app" card, which on an iPhone explains Share → Add to Home Screen.
 */

test("the web app manifest makes it installable", async ({ page, request }) => {
  await page.goto("/")
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  )
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content")
  expect(viewport).toMatch(/width=device-width/)
  expect(viewport).toMatch(/initial-scale=1/)
  expect(viewport).toMatch(/viewport-fit=cover/)
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2)
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  )
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveCount(1)
  await expect(page.locator('meta[name="format-detection"]')).toHaveAttribute(
    "content",
    /telephone=no/,
  )

  const response = await request.get("/manifest.webmanifest")
  expect(response.ok()).toBe(true)
  const manifest = (await response.json()) as {
    id: string
    name: string
    short_name: string
    display: string
    start_url: string
    scope: string
    background_color: string
    theme_color: string
    icons: { src: string; sizes: string; purpose: string; type: string }[]
    shortcuts?: { name: string; url: string; icons: { src: string }[] }[]
  }
  expect(manifest).toMatchObject({
    id: "/app",
    display: "standalone",
    start_url: "/app",
    scope: "/",
  })
  expect(manifest.name.length).toBeGreaterThan(0)
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/)
  const sizes = manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`)
  expect(sizes).toEqual(
    expect.arrayContaining(["192x192 any", "512x512 any", "192x192 maskable", "512x512 maskable"]),
  )
  const iconUrls = [
    ...manifest.icons.map((icon) => icon.src),
    ...(manifest.shortcuts ?? []).flatMap((shortcut) => shortcut.icons.map((icon) => icon.src)),
  ]
  for (const src of iconUrls) {
    const image = await request.get(src)
    expect(image.ok(), src).toBe(true)
    expect(image.headers()["content-type"]).toBe("image/png")
  }
  // Shortcuts only point at pages that exist.
  for (const shortcut of manifest.shortcuts ?? []) {
    expect((await request.get(shortcut.url, { maxRedirects: 0 })).status()).toBeLessThan(400)
  }

  const appleIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href")
  expect(appleIcon).toBe("/icons/apple-touch-icon.png")
  expect((await request.get(appleIcon ?? "/missing")).headers()["content-type"]).toBe("image/png")
  const favicon = await request.get("/favicon.ico")
  expect(favicon.ok()).toBe(true)
  expect(favicon.headers()["content-type"]).toMatch(/icon/)
})

test("the service worker is served uncached, and the offline page is public", async ({
  request,
}) => {
  const sw = await request.get("/sw.js")
  expect(sw.ok()).toBe(true)
  expect(sw.headers()["content-type"]).toMatch(/^application\/javascript/)
  expect(sw.headers()["cache-control"]).toMatch(/no-cache/)
  expect(sw.headers()["cache-control"]).toMatch(/no-store/)
  expect(await sw.text()).toContain('addEventListener("fetch"')

  const offline = await request.get("/offline")
  expect(offline.ok()).toBe(true)
  expect(await offline.text()).toContain("You&#x27;re offline")
})

test("offline, pages fall back to the offline page, and no signed-in page is ever cached", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  const email = uniqueEmail("offline")
  await signUp(page, email, "Olly Offline")
  await chooseRole(page, "creator")
  await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
  await completeOnboardingInDb(email)
  await page.goto("/app")
  await expect(page.getByRole("heading", { level: 1, name: "Creator home" })).toBeVisible()

  // The shell registers the worker (production builds, and NEXT_PUBLIC_ENABLE_SW=1 in e2e); the
  // same registration again is a no-op that waits until it is active.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" })
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true)

  // Visit signed-in pages while the worker is in control.
  for (const path of ["/app/audience", "/app/settings/profile", "/app/me"]) {
    await page.goto(path)
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible()
  }

  // Only the offline page, static files and icons are in the caches; never a page or /api.
  const cached = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) {
        urls.push(new URL(request.url).pathname)
      }
    }
    return urls
  })
  expect(cached).toContain("/offline")
  for (const path of cached) {
    expect(path).toMatch(/^\/(offline$|_next\/static\/|icons\/)/)
  }

  // The offline page and every static file it references are kept together in the offline cache,
  // which is never trimmed (the static cache drops its oldest files first).
  const snapshot = await page.evaluate(async () => {
    const name = (await caches.keys()).find((key) => key.startsWith("app-offline-"))
    if (!name) return null
    const cache = await caches.open(name)
    const html = (await (await cache.match("/offline"))?.text()) ?? ""
    const referenced = [...new Set(html.match(/\/_next\/static\/[^"'\s<>()\\]+/g) ?? [])]
    const missing: string[] = []
    for (const url of referenced) if (!(await cache.match(url))) missing.push(url)
    return { referenced: referenced.length, missing }
  })
  expect(snapshot?.referenced).toBeGreaterThan(0)
  expect(snapshot?.missing).toEqual([])

  // Offline: a page load shows the offline page at the same address, styled, with Try again.
  await context.setOffline(true)
  await page.goto("/app/audience")
  await expect(page.getByRole("heading", { level: 1, name: "You're offline" })).toBeVisible()
  await expect(page).toHaveURL(/\/app\/audience$/)
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible()
  await expect(page.getByText("Olly Offline")).toHaveCount(0)

  // Back online, the page reloads by itself (production builds precache every script the offline
  // page needs; under `next dev` some chunks load lazily, so "Try again" or a reload stands in).
  await context.setOffline(false)
  const audience = page.getByRole("heading", { level: 1, name: "Audience" })
  const reloadedItself = await audience.waitFor({ timeout: 10_000 }).then(
    () => true,
    () => false,
  )
  if (!reloadedItself) await page.reload()
  await expect(audience).toBeVisible()
})

test("with the worker in control, a magic link still signs in (single-use URLs load once)", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const email = uniqueEmail("swlink")
  await signUp(page, email, "Lina Link")
  await chooseRole(page, "creator")
  await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
  await completeOnboardingInDb(email)
  await page.goto("/app")
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" })
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true)

  // Sign out from Me, then back in by link. With navigation preload on, the browser fetched the
  // link twice (preload plus the real request), the second hit found it used up, and sign-in
  // ended on "?error=Verification".
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Me", exact: true })
    .click()
  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(page).toHaveURL(/\/$/)
  await signIn(page, email, "/sign-in?callbackUrl=%2Fapp")
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole("heading", { level: 1, name: "Creator home" })).toBeVisible()
})

test("on an iPhone, the app's home suggests installing, and 'Not now' is remembered", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const email = uniqueEmail("install")
  await signUp(page, email, "Ines Install")
  await chooseRole(page, "builder")
  await expect(page).toHaveURL(/\/onboarding\/builder\/profile$/)
  await completeOnboardingInDb(email)

  await page.goto("/app")
  const card = page.getByRole("complementary", { name: "Install the app" })
  await expect(card).toBeVisible()
  await card.getByRole("button", { name: "Show me how" }).click()
  const steps = page.getByRole("dialog", { name: "Add the app to your home screen" })
  await expect(steps).toBeVisible()
  await expect(steps).toContainText("Add to Home Screen")
  await steps.getByRole("button", { name: "Got it" }).click()
  await expect(steps).toBeHidden()

  // Not on other pages; and on Me it stays available as a row.
  await page.goto("/app/settings/profile")
  await expect(page.getByRole("complementary", { name: "Install the app" })).toHaveCount(0)
  await page.goto("/app/me")
  await expect(page.locator("main li", { hasText: "Install the app" })).toBeVisible()

  await page.goto("/app")
  await card.getByRole("button", { name: /^Not now/ }).click()
  await expect(card).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: "Builder home" })).toBeVisible()
  await expect(page.getByRole("complementary", { name: "Install the app" })).toHaveCount(0)
})

test("installed (standalone), the app offers no install card", async ({ page }) => {
  test.setTimeout(60_000)
  const email = uniqueEmail("standalone")
  await signUp(page, email, "Sam Standalone")
  await chooseRole(page, "creator")
  await expect(page).toHaveURL(/\/onboarding\/creator\/profile$/)
  await completeOnboardingInDb(email)
  // iOS's own flag for home screen apps.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true })
  })
  await page.goto("/app")
  await expect(page.getByRole("heading", { level: 1, name: "Creator home" })).toBeVisible()
  await expect(page.getByRole("complementary", { name: "Install the app" })).toHaveCount(0)
  await page.goto("/app/me")
  await expect(page.locator("main li", { hasText: "Install the app" })).toContainText("Installed")
})
