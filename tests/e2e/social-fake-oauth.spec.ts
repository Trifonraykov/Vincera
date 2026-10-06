import { expect, test } from "./fixtures"

/**
 * The fake social consent screen (lib/social/fake/authorize-page.ts) in a real browser: the form
 * post must be allowed by the page's CSP (`form-action` also covers the redirect that follows)
 * and land on our callback with a code and the state, like Google would. The callback itself is
 * covered by the connection flow specs; here only its request is observed.
 */

// RFC 7636 appendix B challenge; the page only checks its shape.
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

function authorizePath(callback: string, state: string): string {
  const params = new URLSearchParams({
    client_id: "fake-youtube-client",
    redirect_uri: callback,
    response_type: "code",
    scope:
      "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly",
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
  })
  return `/api/dev/fake-oauth/youtube/authorize?${params.toString()}`
}

test("fake YouTube consent redirects to the callback with a code and the state", async ({
  page,
  baseURL,
}) => {
  const callback = `${baseURL}/api/oauth/youtube/callback`
  await page.goto(authorizePath(callback, "e2e-state-allow"))

  await expect(page.getByRole("heading", { name: "Connect a YouTube account" })).toBeVisible()
  await expect(page.getByRole("button", { name: /Authorize as Quiet Kitchen/ })).toBeVisible()

  const callbackRequest = page.waitForRequest((request) => request.url().startsWith(callback))
  await page.getByRole("button", { name: /Authorize as Ada Codes/ }).click()
  const url = new URL((await callbackRequest).url())
  expect(url.searchParams.get("state")).toBe("e2e-state-allow")
  expect(url.searchParams.get("code")).toMatch(/^fkc_/)
})

test("cancelling the fake consent returns access_denied", async ({ page, baseURL }) => {
  const callback = `${baseURL}/api/oauth/youtube/callback`
  await page.goto(authorizePath(callback, "e2e-state-deny"))

  const callbackRequest = page.waitForRequest((request) => request.url().startsWith(callback))
  await page.getByRole("button", { name: "Cancel" }).click()
  const url = new URL((await callbackRequest).url())
  expect(url.searchParams.get("error")).toBe("access_denied")
  expect(url.searchParams.get("state")).toBe("e2e-state-deny")
  expect(url.searchParams.has("code")).toBe(false)
})

test("the fake consent screen refuses a foreign redirect_uri", async ({ page }) => {
  const response = await page.goto(authorizePath("https://evil.example/callback", "s"))
  expect(response?.status()).toBe(400)
  await expect(page.getByRole("alert")).toContainText("redirect_uri")
})
