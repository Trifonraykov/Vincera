import { describe, expect, it, vi } from "vitest"

import { areaOf, guardRoute, type OnboardingStepResolver } from "@/lib/auth/route-guard"
import { appRolesOf, type AuthUser } from "@/lib/auth/user"

import { authUser } from "../../helpers/auth-users"

/** Stand-in for lib/onboarding/gate.ts: users without an app role pick one; others pass. */
const roleOnly: OnboardingStepResolver = async (user) =>
  appRolesOf(user).length === 0 ? "/onboarding/role" : null

function guard(path: string, user: AuthUser | null, resolve: OnboardingStepResolver = roleOnly) {
  const url = new URL(path, "http://localhost")
  return guardRoute(url, user, resolve)
}

const creator = authUser({ roles: ["creator"], activeRole: "creator" })
const newUser = authUser({ roles: [], activeRole: null })
const admin = authUser({ roles: ["admin"], activeRole: null })
const suspended = authUser({ status: "suspended" })

describe("areaOf", () => {
  it("classifies guarded paths and ignores lookalikes", () => {
    expect(areaOf("/app")).toBe("app")
    expect(areaOf("/app/ideas/1")).toBe("app")
    expect(areaOf("/apple")).toBeNull()
    expect(areaOf("/onboarding/role")).toBe("onboarding")
    expect(areaOf("/admin/users")).toBe("admin")
    expect(areaOf("/administrator")).toBeNull()
    expect(areaOf("/sign-in")).toBe("auth")
    expect(areaOf("/sign-up")).toBe("auth")
    expect(areaOf("/")).toBeNull()
  })
})

describe("guardRoute", () => {
  it("sends signed-out visitors of protected areas to sign-in with a callbackUrl", async () => {
    await expect(guard("/app/ideas?tab=open", null)).resolves.toEqual({
      type: "redirect",
      to: "/sign-in?callbackUrl=%2Fapp%2Fideas%3Ftab%3Dopen",
    })
    await expect(guard("/onboarding/role", null)).resolves.toEqual({
      type: "redirect",
      to: "/sign-in?callbackUrl=%2Fonboarding%2Frole",
    })
    await expect(guard("/admin", null)).resolves.toEqual({
      type: "redirect",
      to: "/sign-in?callbackUrl=%2Fadmin",
    })
  })

  it("lets anyone open public pages and signed-out visitors open the auth pages", async () => {
    await expect(guard("/pricing", null)).resolves.toEqual({ type: "next" })
    await expect(guard("/sign-in", null)).resolves.toEqual({ type: "next" })
    await expect(guard("/sign-up", null)).resolves.toEqual({ type: "next" })
  })

  it("sends users without a role from /app to onboarding", async () => {
    await expect(guard("/app", newUser)).resolves.toEqual({
      type: "redirect",
      to: "/onboarding/role",
    })
    await expect(guard("/app/settings/profile", newUser)).resolves.toEqual({
      type: "redirect",
      to: "/onboarding/role",
    })
    await expect(guard("/onboarding/role", newUser)).resolves.toEqual({ type: "next" })
    await expect(guard("/app", creator)).resolves.toEqual({ type: "next" })
  })

  it("sends /app visitors with unfinished onboarding to the step the resolver names", async () => {
    const resolve = vi.fn<OnboardingStepResolver>(async () => "/onboarding/creator/connect")
    await expect(guard("/app/audience", creator, resolve)).resolves.toEqual({
      type: "redirect",
      to: "/onboarding/creator/connect",
    })
    expect(resolve).toHaveBeenCalledWith(creator)

    // Only /app is gated on onboarding: onboarding pages, admin and auth pages never ask.
    resolve.mockClear()
    await expect(guard("/onboarding/creator/profile", creator, resolve)).resolves.toEqual({
      type: "next",
    })
    await expect(guard("/admin", { ...creator, roles: ["admin"] }, resolve)).resolves.toEqual({
      type: "next",
    })
    await expect(guard("/app", null, resolve)).resolves.toMatchObject({ type: "redirect" })
    await expect(guard("/app", suspended, resolve)).resolves.toMatchObject({ type: "redirect" })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("redirects non-admins from /admin to /app and lets admins in", async () => {
    await expect(guard("/admin", creator)).resolves.toEqual({ type: "redirect", to: "/app" })
    await expect(guard("/admin/users", creator)).resolves.toEqual({ type: "redirect", to: "/app" })
    await expect(guard("/admin", admin)).resolves.toEqual({ type: "next" })
    // An admin-only user still onboards before using /app.
    await expect(guard("/app", admin)).resolves.toEqual({
      type: "redirect",
      to: "/onboarding/role",
    })
  })

  it("sends suspended users to the sign-in page with an explanation", async () => {
    const expected = { type: "redirect", to: "/sign-in?error=AccountSuspended" }
    await expect(guard("/app", suspended)).resolves.toEqual(expected)
    await expect(guard("/onboarding/role", suspended)).resolves.toEqual(expected)
    await expect(guard("/admin", { ...suspended, roles: ["admin"] })).resolves.toEqual(expected)
    await expect(guard("/sign-in?error=AccountSuspended", suspended)).resolves.toEqual({
      type: "next",
    })
  })

  it("sends signed-in users away from the auth pages, honouring a safe callbackUrl", async () => {
    await expect(guard("/sign-in", creator)).resolves.toEqual({ type: "redirect", to: "/app" })
    await expect(guard("/sign-up", creator)).resolves.toEqual({ type: "redirect", to: "/app" })
    await expect(guard("/sign-in?callbackUrl=%2Fapp%2Fideas", creator)).resolves.toEqual({
      type: "redirect",
      to: "/app/ideas",
    })
    await expect(
      guard("/sign-in?callbackUrl=https%3A%2F%2Fevil.example", creator),
    ).resolves.toEqual({
      type: "redirect",
      to: "/app",
    })
    // Dot segments that normalise to a protocol-relative "//evil.example".
    for (const callbackUrl of ["/.//evil.example", "/%2e//evil.example", "/a/..//evil.example"]) {
      await expect(
        guard(`/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`, creator),
      ).resolves.toEqual({
        type: "redirect",
        to: "/app",
      })
    }
    // Error pages stay visible (e.g. "this account is already linked").
    await expect(guard("/sign-in?error=OAuthAccountNotLinked", creator)).resolves.toEqual({
      type: "next",
    })
  })
})
