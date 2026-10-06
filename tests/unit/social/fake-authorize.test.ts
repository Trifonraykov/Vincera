import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { GET, POST } from "@/app/api/dev/fake-oauth/[provider]/authorize/route"
import { createCodeVerifier, pkceChallenge } from "@/lib/social/pkce"
import type { SocialProviderId } from "@/lib/social/types"

import { callbackUrl, fakeProvider, resetSocialTest, setupSocialTest } from "./helpers"

beforeEach(() => setupSocialTest())
afterEach(() => resetSocialTest())

const context = (provider: string) => ({ params: Promise.resolve({ provider }) })

function authorizeUrl(provider: SocialProviderId, params: Record<string, string>): string {
  const url = new URL(`http://localhost:3000/api/dev/fake-oauth/${provider}/authorize`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

/** The parameters the fake provider's own authUrl() produces. */
function paramsFromProvider(provider: SocialProviderId, state: string, challenge?: string) {
  const url = new URL(
    fakeProvider(provider).provider.authUrl(
      state,
      challenge ? { codeChallenge: challenge, codeChallengeMethod: "S256" } : undefined,
    ),
  )
  return Object.fromEntries(url.searchParams)
}

function post(provider: SocialProviderId, fields: Record<string, string>): Promise<Response> {
  return POST(
    new Request(`http://localhost:3000/api/dev/fake-oauth/${provider}/authorize`, {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    context(provider),
  )
}

describe("fake authorize page: GET", () => {
  it("lists the fixture accounts with an Authorize button each", async () => {
    const params = paramsFromProvider(
      "youtube",
      "st<ate>",
      pkceChallenge(createCodeVerifier()).codeChallenge,
    )
    const response = await GET(new Request(authorizeUrl("youtube", params)), context("youtube"))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(response.headers.get("cache-control")).toBe("no-store")
    const csp = response.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("form-action 'self' http://localhost:3000")
    const html = await response.text()
    expect(html).toContain("Authorize as Ada Codes (48.2K subscribers)")
    expect(html).toContain("Authorize as Quiet Kitchen")
    expect(html).toContain("Authorize as Lapsed Lens")
    // The state is carried through, escaped.
    expect(html).toContain('value="st&lt;ate&gt;"')
    expect(html).not.toContain("st<ate>")
  })

  it("accepts GitHub's request without response_type, and TikTok's client_key", async () => {
    const github = await GET(
      new Request(authorizeUrl("github", paramsFromProvider("github", "s1", "c".repeat(43)))),
      context("github"),
    )
    expect(github.status).toBe(200)
    expect(await github.text()).toContain("Requested access: public, read-only data.")

    const tiktok = await GET(
      new Request(authorizeUrl("tiktok", paramsFromProvider("tiktok", "s2"))),
      context("tiktok"),
    )
    expect(tiktok.status).toBe(200)
    expect(await tiktok.text()).toContain('name="client_key"')
  })

  it("refuses bad requests on the page instead of redirecting", async () => {
    const params = paramsFromProvider("youtube", "s")
    for (const bad of [
      { ...params, redirect_uri: "https://evil.example/callback" },
      { ...params, response_type: "token" },
      { ...params, state: "" },
      { ...params, code_challenge: "c".repeat(43), code_challenge_method: "" },
    ]) {
      const response = await GET(new Request(authorizeUrl("youtube", bad)), context("youtube"))
      expect(response.status).toBe(400)
      expect(response.headers.get("location")).toBeNull()
      expect(await response.text()).toContain("This authorization request was refused")
    }
  })

  it("answers 404 for unknown providers and for providers that are not fake", async () => {
    const unknown = await GET(new Request(authorizeUrl("youtube", {})), context("myspace"))
    expect(unknown.status).toBe(404)

    setupSocialTest({ GOOGLE_YT_CLIENT_ID: "yt-id", GOOGLE_YT_CLIENT_SECRET: "yt-secret" })
    const live = await GET(
      new Request(authorizeUrl("youtube", paramsFromProvider("github", "s"))),
      context("youtube"),
    )
    expect(live.status).toBe(404)
    const livePost = await post("youtube", { decision: "allow", account: "ada-codes" })
    expect(livePost.status).toBe(404)
  })
})

describe("fake authorize page: POST", () => {
  it("redirects to the callback with a code the provider can exchange (PKCE checked)", async () => {
    const verifier = createCodeVerifier()
    const params = paramsFromProvider("youtube", "state-42", pkceChallenge(verifier).codeChallenge)
    const response = await post("youtube", { ...params, account: "ada-codes", decision: "allow" })

    expect(response.status).toBe(303)
    const location = new URL(response.headers.get("location")!)
    expect(`${location.origin}${location.pathname}`).toBe(callbackUrl("youtube"))
    expect(location.searchParams.get("state")).toBe("state-42")
    const code = location.searchParams.get("code")!
    expect(code).toMatch(/^fkc_/)

    const { provider } = fakeProvider("youtube")
    const token = await provider.exchangeCode(code, { codeVerifier: verifier })
    expect((await provider.fetchProfile(token)).username).toBe("@adacodes")
  })

  it("appends Instagram's #_ fragment, which the code exchange tolerates", async () => {
    const params = paramsFromProvider("instagram", "ig-state")
    const response = await post("instagram", {
      ...params,
      account: "tiny-studio",
      decision: "allow",
    })
    const location = response.headers.get("location")!
    expect(location.endsWith("#_")).toBe(true)
    const code = new URL(location).searchParams.get("code")!

    const { provider } = fakeProvider("instagram")
    const token = await provider.exchangeCode(code)
    expect((await provider.fetchProfile(token)).username).toBe("tiny.studio")
  })

  it("sends access_denied back when the user cancels", async () => {
    const params = paramsFromProvider("tiktok", "t-state")
    const response = await post("tiktok", { ...params, decision: "deny" })
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get("location")!)
    expect(location.searchParams.get("error")).toBe("access_denied")
    expect(location.searchParams.get("state")).toBe("t-state")
    expect(location.searchParams.has("code")).toBe(false)
  })

  it("refuses unknown accounts and tampered redirect URIs", async () => {
    const params = paramsFromProvider("github", "g")
    const unknown = await post("github", {
      ...params,
      account: "../youtube/ada-codes",
      decision: "allow",
    })
    expect(unknown.status).toBe(400)

    const evil = await post("github", {
      ...params,
      redirect_uri: "https://evil.example/cb",
      account: "octo-builder",
      decision: "allow",
    })
    expect(evil.status).toBe(400)
    expect(evil.headers.get("location")).toBeNull()
  })
})
