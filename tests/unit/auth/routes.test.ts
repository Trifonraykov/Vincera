import { describe, expect, it } from "vitest"

import {
  SIGN_IN_ERROR_MESSAGES,
  safeCallbackUrl,
  sameOriginRedirectUrl,
  signInErrorMessage,
  signInUrl,
} from "@/lib/auth/routes"

describe("safeCallbackUrl", () => {
  it.each([
    ["/app", "/app"],
    ["/app/ideas?tab=open#top", "/app/ideas?tab=open#top"],
    ["/admin", "/admin"],
    ["/onboarding/role", "/onboarding/role"],
    ["/app/../admin", "/admin"],
  ])("keeps the same-origin path %s", (input, expected) => {
    expect(safeCallbackUrl(input)).toBe(expected)
  })

  it.each([
    [undefined],
    [null],
    [""],
    ["app"],
    ["https://evil.example/app"],
    ["//evil.example/app"],
    ["/\\evil.example"],
    ["/app\\..\\evil"],
    ["/app\nLocation: https://evil.example"],
    ["javascript:alert(1)"],
    ["/sign-in"],
    ["/sign-in?callbackUrl=/app"],
    ["/sign-up"],
    ["/api/auth/signout"],
    // Dot segments collapse into a protocol-relative "//evil.example" once parsed.
    ["/.//evil.example"],
    ["/%2e//evil.example"],
    ["/%2E%2E//evil.example"],
    ["/a/..//evil.example"],
    ["/app/%2e%2e//evil.example/x?y=1"],
    ["/..//evil.example"],
  ])("falls back for %j", (input) => {
    expect(safeCallbackUrl(input)).toBe("/app")
    expect(safeCallbackUrl(input, "/")).toBe("/")
  })

  it("does not treat lookalike prefixes as auth pages", () => {
    expect(safeCallbackUrl("/sign-instructions")).toBe("/sign-instructions")
    expect(safeCallbackUrl("/apis")).toBe("/apis")
  })
})

describe("sameOriginRedirectUrl", () => {
  const base = "https://app.example.com/sign-in?callbackUrl=x"

  it("resolves in-app targets against the request URL", () => {
    expect(sameOriginRedirectUrl("/app/ideas?x=1", base).href).toBe(
      "https://app.example.com/app/ideas?x=1",
    )
    expect(sameOriginRedirectUrl("/app//evil.example", base).href).toBe(
      "https://app.example.com/app//evil.example",
    )
  })

  it.each([["//evil.example"], ["https://evil.example/app"], ["/\\evil.example"], ["http:"]])(
    "replaces the off-site target %j with /app",
    (to) => {
      expect(sameOriginRedirectUrl(to, base).href).toBe("https://app.example.com/app")
    },
  )
})

describe("signInUrl", () => {
  it("builds /sign-in with an encoded callbackUrl and error", () => {
    expect(signInUrl()).toBe("/sign-in")
    expect(signInUrl({ callbackUrl: "/app/ideas?x=1" })).toBe(
      "/sign-in?callbackUrl=%2Fapp%2Fideas%3Fx%3D1",
    )
    expect(signInUrl({ error: "AccountSuspended" })).toBe("/sign-in?error=AccountSuspended")
  })

  it("drops unsafe callback URLs", () => {
    expect(signInUrl({ callbackUrl: "https://evil.example" })).toBe("/sign-in")
  })
})

describe("signInErrorMessage", () => {
  it("maps known codes and falls back to a generic message", () => {
    expect(signInErrorMessage(null)).toBeNull()
    expect(signInErrorMessage("Verification")).toBe(SIGN_IN_ERROR_MESSAGES.Verification)
    expect(signInErrorMessage("SomethingNew")).toBe(SIGN_IN_ERROR_MESSAGES.Default)
    expect(signInErrorMessage("constructor")).toBe(SIGN_IN_ERROR_MESSAGES.Default)
  })
})
