import { describe, expect, it } from "vitest"

import { areaOf, guardRoute } from "@/lib/auth/route-guard"
import type { AuthUser } from "@/lib/auth/user"

import { authUser } from "../../helpers/auth-users"

function guard(path: string, user: AuthUser | null) {
  const url = new URL(path, "http://localhost")
  return guardRoute(url, user)
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
  it("sends signed-out visitors of protected areas to sign-in with a callbackUrl", () => {
    expect(guard("/app/ideas?tab=open", null)).toEqual({
      type: "redirect",
      to: "/sign-in?callbackUrl=%2Fapp%2Fideas%3Ftab%3Dopen",
    })
    expect(guard("/onboarding/role", null)).toEqual({
      type: "redirect",
      to: "/sign-in?callbackUrl=%2Fonboarding%2Frole",
    })
    expect(guard("/admin", null)).toEqual({
      type: "redirect",
      to: "/sign-in?callbackUrl=%2Fadmin",
    })
  })

  it("lets anyone open public pages and signed-out visitors open the auth pages", () => {
    expect(guard("/pricing", null)).toEqual({ type: "next" })
    expect(guard("/sign-in", null)).toEqual({ type: "next" })
    expect(guard("/sign-up", null)).toEqual({ type: "next" })
  })

  it("sends users without a role from /app to onboarding", () => {
    expect(guard("/app", newUser)).toEqual({ type: "redirect", to: "/onboarding/role" })
    expect(guard("/app/settings/profile", newUser)).toEqual({
      type: "redirect",
      to: "/onboarding/role",
    })
    expect(guard("/onboarding/role", newUser)).toEqual({ type: "next" })
    expect(guard("/app", creator)).toEqual({ type: "next" })
  })

  it("redirects non-admins from /admin to /app and lets admins in", () => {
    expect(guard("/admin", creator)).toEqual({ type: "redirect", to: "/app" })
    expect(guard("/admin/users", creator)).toEqual({ type: "redirect", to: "/app" })
    expect(guard("/admin", admin)).toEqual({ type: "next" })
    // An admin-only user still onboards before using /app.
    expect(guard("/app", admin)).toEqual({ type: "redirect", to: "/onboarding/role" })
  })

  it("sends suspended users to the sign-in page with an explanation", () => {
    const expected = { type: "redirect", to: "/sign-in?error=AccountSuspended" }
    expect(guard("/app", suspended)).toEqual(expected)
    expect(guard("/onboarding/role", suspended)).toEqual(expected)
    expect(guard("/admin", { ...suspended, roles: ["admin"] })).toEqual(expected)
    expect(guard("/sign-in?error=AccountSuspended", suspended)).toEqual({ type: "next" })
  })

  it("sends signed-in users away from the auth pages, honouring a safe callbackUrl", () => {
    expect(guard("/sign-in", creator)).toEqual({ type: "redirect", to: "/app" })
    expect(guard("/sign-up", creator)).toEqual({ type: "redirect", to: "/app" })
    expect(guard("/sign-in?callbackUrl=%2Fapp%2Fideas", creator)).toEqual({
      type: "redirect",
      to: "/app/ideas",
    })
    expect(guard("/sign-in?callbackUrl=https%3A%2F%2Fevil.example", creator)).toEqual({
      type: "redirect",
      to: "/app",
    })
    // Dot segments that normalise to a protocol-relative "//evil.example".
    for (const callbackUrl of ["/.//evil.example", "/%2e//evil.example", "/a/..//evil.example"]) {
      expect(guard(`/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`, creator)).toEqual({
        type: "redirect",
        to: "/app",
      })
    }
    // Error pages stay visible (e.g. "this account is already linked").
    expect(guard("/sign-in?error=OAuthAccountNotLinked", creator)).toEqual({ type: "next" })
  })
})
