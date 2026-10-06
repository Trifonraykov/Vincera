import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { encrypt } from "@/lib/crypto"
import {
  beginOAuthState,
  clearedOAuthStateCookie,
  DEFAULT_CONNECT_RETURN_TO,
  OAUTH_STATE_TTL_SECONDS,
  timingSafeStringEqual,
  verifyOAuthState,
} from "@/lib/social/oauth-cookie"
import {
  codeChallengeFor,
  createCodeVerifier,
  isValidCodeVerifier,
  pkceChallenge,
} from "@/lib/social/pkce"
import { tokenNeedsRefresh } from "@/lib/social/tokens"

import { NOW, resetSocialTest, setClock, setupSocialTest } from "./helpers"

beforeEach(() => setupSocialTest())
afterEach(() => resetSocialTest())

const USER = "0190a000-0000-7000-8000-000000000001"
const OTHER_USER = "0190a000-0000-7000-8000-000000000002"

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    expect(codeChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    )
  })

  it("creates random, valid 43-character verifiers with S256 challenges", () => {
    const a = createCodeVerifier()
    const b = createCodeVerifier()
    expect(a).not.toBe(b)
    expect(a).toHaveLength(43)
    expect(isValidCodeVerifier(a)).toBe(true)
    expect(pkceChallenge(a)).toEqual({
      codeChallenge: codeChallengeFor(a),
      codeChallengeMethod: "S256",
    })
    expect(isValidCodeVerifier("short")).toBe(false)
    expect(isValidCodeVerifier("x".repeat(129))).toBe(false)
    expect(isValidCodeVerifier(`${"x".repeat(42)}!`)).toBe(false)
  })
})

describe("OAuth state cookie", () => {
  it("is an encrypted, httpOnly, lax, 10-minute cookie scoped to the provider's OAuth routes", () => {
    const start = beginOAuthState({
      provider: "youtube",
      userId: USER,
      returnTo: "/onboarding/creator/connect",
      usePkce: true,
    })
    expect(start.cookie.name).toBe("oauth_state_youtube")
    expect(start.cookie.options).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/api/oauth/youtube",
      maxAge: OAUTH_STATE_TTL_SECONDS,
    })
    expect(OAUTH_STATE_TTL_SECONDS).toBe(600)
    // Nothing readable in the value: not the state, the verifier, the user or the path.
    expect(start.cookie.value).not.toContain(start.state)
    expect(start.cookie.value).not.toContain(USER)
    expect(start.cookie.value).not.toContain("onboarding")
    expect(start.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(start.pkce?.codeChallengeMethod).toBe("S256")
  })

  it("is Secure when the app is served over HTTPS", () => {
    setupSocialTest({ NEXT_PUBLIC_APP_URL: "https://app.example.com" })
    const start = beginOAuthState({
      provider: "github",
      userId: USER,
      returnTo: null,
      usePkce: true,
    })
    expect(start.cookie.options.secure).toBe(true)
  })

  it("round-trips the PKCE verifier and returnTo for the same user and state", () => {
    const start = beginOAuthState({
      provider: "youtube",
      userId: USER,
      returnTo: "/onboarding/creator/connect?step=2",
      usePkce: true,
    })
    const check = verifyOAuthState({
      provider: "youtube",
      userId: USER,
      cookieValue: start.cookie.value,
      state: start.state,
    })
    expect(check).toEqual({
      ok: true,
      codeVerifier: expect.any(String),
      returnTo: "/onboarding/creator/connect?step=2",
    })
    if (!check.ok) throw new Error("unreachable")
    expect(pkceChallenge(check.codeVerifier!).codeChallenge).toBe(start.pkce!.codeChallenge)
  })

  it("stores no verifier for providers without PKCE", () => {
    const start = beginOAuthState({
      provider: "instagram",
      userId: USER,
      returnTo: "/app/settings/connections",
      usePkce: false,
    })
    expect(start.pkce).toBeUndefined()
    const check = verifyOAuthState({
      provider: "instagram",
      userId: USER,
      cookieValue: start.cookie.value,
      state: start.state,
    })
    expect(check).toMatchObject({ ok: true, codeVerifier: null })
  })

  it("falls back to the connections page for unsafe or missing returnTo values", () => {
    for (const returnTo of [
      "https://evil.example/x",
      "//evil.example",
      "/api/oauth/youtube/start",
      "/sign-in",
      null,
    ]) {
      const start = beginOAuthState({ provider: "tiktok", userId: USER, returnTo, usePkce: false })
      const check = verifyOAuthState({
        provider: "tiktok",
        userId: USER,
        cookieValue: start.cookie.value,
        state: start.state,
      })
      expect(check).toMatchObject({ ok: true, returnTo: DEFAULT_CONNECT_RETURN_TO })
    }
  })

  it("refuses a wrong state, another user, an expired cookie, and tampering", () => {
    const start = beginOAuthState({
      provider: "youtube",
      userId: USER,
      returnTo: "/onboarding/creator/connect",
      usePkce: true,
    })
    const verify = (overrides: Partial<Parameters<typeof verifyOAuthState>[0]>) =>
      verifyOAuthState({
        provider: "youtube",
        userId: USER,
        cookieValue: start.cookie.value,
        state: start.state,
        ...overrides,
      })

    expect(verify({ state: `${start.state}x` })).toEqual({
      ok: false,
      reason: "state_mismatch",
      returnTo: "/onboarding/creator/connect",
    })
    expect(verify({ state: null })).toMatchObject({ ok: false, reason: "state_mismatch" })
    expect(verify({ userId: OTHER_USER })).toMatchObject({ ok: false, reason: "user_mismatch" })
    expect(verify({ cookieValue: undefined })).toEqual({
      ok: false,
      reason: "missing",
      returnTo: DEFAULT_CONNECT_RETURN_TO,
    })
    // Flip the first character of the ciphertext (a whole 6 bits, never base64 padding).
    const [version, iv, tag, data = ""] = start.cookie.value.split(":")
    const tampered = `${data[0] === "A" ? "B" : "A"}${data.slice(1)}`
    expect(verify({ cookieValue: [version, iv, tag, tampered].join(":") })).toMatchObject({
      ok: false,
      reason: "invalid",
    })
    // The provider is bound into the ciphertext (AAD): another provider's callback cannot use it.
    expect(verify({ provider: "github" })).toMatchObject({ ok: false, reason: "invalid" })

    setClock(new Date(NOW.getTime() + (OAUTH_STATE_TTL_SECONDS + 1) * 1000))
    expect(verify({})).toMatchObject({ ok: false, reason: "expired" })
  })

  it("refuses a well-encrypted payload of the wrong shape or provider", () => {
    const aad = "social_oauth_state:youtube"
    const wrongShape = encrypt(JSON.stringify({ v: 2 }), { aad })
    expect(
      verifyOAuthState({ provider: "youtube", userId: USER, cookieValue: wrongShape, state: "s" }),
    ).toMatchObject({ ok: false, reason: "invalid" })

    const otherProvider = encrypt(
      JSON.stringify({
        v: 1,
        provider: "github",
        userId: USER,
        state: "s",
        codeVerifier: null,
        returnTo: "/app",
        exp: NOW.getTime() + 60_000,
      }),
      { aad },
    )
    expect(
      verifyOAuthState({
        provider: "youtube",
        userId: USER,
        cookieValue: otherProvider,
        state: "s",
      }),
    ).toMatchObject({ ok: false, reason: "provider_mismatch" })
  })

  it("clears the cookie with the same name and path", () => {
    expect(clearedOAuthStateCookie("github")).toMatchObject({
      name: "oauth_state_github",
      value: "",
      options: { path: "/api/oauth/github", maxAge: 0, httpOnly: true },
    })
  })

  it("compares strings in constant time regardless of length", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true)
    expect(timingSafeStringEqual("abc", "abd")).toBe(false)
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false)
    expect(timingSafeStringEqual("", "")).toBe(true)
  })
})

describe("tokenNeedsRefresh", () => {
  const at = NOW
  const minutes = (n: number) => new Date(at.getTime() + n * 60_000)

  it("refreshes short-lived tokens within 5 minutes of expiry", () => {
    expect(tokenNeedsRefresh("youtube", { expiresAt: minutes(10) }, at)).toBe(false)
    expect(tokenNeedsRefresh("youtube", { expiresAt: minutes(4) }, at)).toBe(true)
    expect(tokenNeedsRefresh("tiktok", { expiresAt: minutes(-1) }, at)).toBe(true)
  })

  it("never refreshes non-expiring tokens", () => {
    expect(tokenNeedsRefresh("github", { expiresAt: null }, at)).toBe(false)
    expect(tokenNeedsRefresh("youtube", { expiresAt: null }, at)).toBe(false)
  })

  it("refreshes Instagram tokens once they are a day old", () => {
    const expiresAt = new Date(at.getTime() + 50 * 86_400_000)
    expect(tokenNeedsRefresh("instagram", { expiresAt, obtainedAt: minutes(-23 * 60) }, at)).toBe(
      false,
    )
    expect(tokenNeedsRefresh("instagram", { expiresAt, obtainedAt: minutes(-25 * 60) }, at)).toBe(
      true,
    )
    // Unknown issue time: estimated from the 60-day lifetime (here 10 days old).
    expect(tokenNeedsRefresh("instagram", { expiresAt }, at)).toBe(true)
  })
})
