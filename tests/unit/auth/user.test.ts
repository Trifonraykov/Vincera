import { describe, expect, it } from "vitest"

import { appRolesOf, parseAuthUser, sortRoles, toSessionUser } from "@/lib/auth/user"

import { authUser } from "../../helpers/auth-users"

describe("parseAuthUser", () => {
  it("parses the users row the session callback receives (Dates, extra columns)", () => {
    const completedAt = new Date("2026-02-03T04:05:06.000Z")
    const row = {
      ...authUser({ roles: ["builder", "admin"], activeRole: "builder" }),
      onboardingCompletedAt: completedAt,
      emailVerified: new Date(),
      createdAt: new Date(),
    }
    expect(parseAuthUser(row)).toEqual({
      ...authUser({ roles: ["builder", "admin"], activeRole: "builder" }),
      onboardingCompletedAt: completedAt,
    })
  })

  it("round-trips through the JSON session payload", () => {
    const user = authUser({ onboardingCompletedAt: new Date("2026-02-03T04:05:06.000Z") })
    const json: unknown = JSON.parse(JSON.stringify(toSessionUser(user)))
    expect(parseAuthUser(json)).toEqual(user)
  })

  it("normalises blank names and images to null", () => {
    expect(parseAuthUser({ ...authUser(), name: "  ", image: undefined })).toMatchObject({
      name: null,
      image: null,
    })
  })

  it("fails closed on missing or malformed data", () => {
    expect(parseAuthUser(undefined)).toBeNull()
    expect(parseAuthUser({ id: "x" })).toBeNull()
    expect(parseAuthUser({ ...authUser(), roles: ["owner"] })).toBeNull()
    expect(parseAuthUser({ ...authUser(), status: "deleted" })).toBeNull()
    expect(parseAuthUser({ ...authUser(), email: null })).toBeNull()
  })
})

describe("role helpers", () => {
  it("appRolesOf drops admin and keeps canonical order", () => {
    expect(appRolesOf({ roles: ["admin", "builder", "creator"] })).toEqual(["creator", "builder"])
    expect(appRolesOf({ roles: ["admin"] })).toEqual([])
  })

  it("sortRoles dedupes and orders creator, builder, admin", () => {
    expect(sortRoles(["admin", "creator", "admin", "builder"])).toEqual([
      "creator",
      "builder",
      "admin",
    ])
  })
})
