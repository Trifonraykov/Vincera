import { describe, expect, it } from "vitest"

import {
  canAccessAdmin,
  canEditLaunch,
  canManageOwnAccount,
  canSendProposal,
  canSwitchToRole,
  canViewCollab,
  hasCompletedOnboarding,
  hasRole,
  isActive,
  isAdmin,
  isCollabMember,
} from "@/lib/auth/authz"

import { authUser, OTHER_USER_ID } from "../../helpers/auth-users"

const ONBOARDED = new Date("2026-01-01T00:00:00Z")

describe("roles and status", () => {
  it("hasRole checks users.roles", () => {
    const user = authUser({ roles: ["creator", "admin"] })
    expect(hasRole(user, "creator")).toBe(true)
    expect(hasRole(user, "admin")).toBe(true)
    expect(hasRole(user, "builder")).toBe(false)
  })

  it("isAdmin and canAccessAdmin need the admin role and an active account", () => {
    expect(isAdmin(authUser({ roles: ["admin"] }))).toBe(true)
    expect(canAccessAdmin(authUser({ roles: ["creator", "admin"] }))).toBe(true)
    expect(canAccessAdmin(authUser({ roles: ["creator", "builder"] }))).toBe(false)
    expect(canAccessAdmin(authUser({ roles: ["admin"], status: "suspended" }))).toBe(false)
  })

  it("isActive is false for suspended users", () => {
    expect(isActive(authUser())).toBe(true)
    expect(isActive(authUser({ status: "suspended" }))).toBe(false)
  })

  it("canManageOwnAccount lets any active user manage their own account", () => {
    expect(canManageOwnAccount(authUser({ roles: [] }))).toBe(true)
    expect(canManageOwnAccount(authUser({ roles: ["creator"] }))).toBe(true)
    expect(canManageOwnAccount(authUser({ status: "suspended" }))).toBe(false)
  })

  it("canSwitchToRole allows only app roles the user has", () => {
    const both = authUser({ roles: ["creator", "builder", "admin"] })
    expect(canSwitchToRole(both, "builder")).toBe(true)
    expect(canSwitchToRole(both, "creator")).toBe(true)
    expect(canSwitchToRole(both, "admin")).toBe(false)
    expect(canSwitchToRole(both, "owner")).toBe(false)
    expect(canSwitchToRole(authUser({ roles: ["creator"] }), "builder")).toBe(false)
    expect(canSwitchToRole(authUser({ roles: ["builder"], status: "suspended" }), "builder")).toBe(
      false,
    )
  })

  it("hasCompletedOnboarding reads onboarding_completed_at", () => {
    expect(hasCompletedOnboarding(authUser())).toBe(false)
    expect(hasCompletedOnboarding(authUser({ onboardingCompletedAt: ONBOARDED }))).toBe(true)
  })
})

describe("collab rules", () => {
  const member = authUser()
  const collab = { memberUserIds: [member.id, OTHER_USER_ID] }
  const outsider = authUser({ id: "0190a000-0000-7000-8000-0000000000ff" })

  it("members and admins can view a collab; others cannot (§6)", () => {
    expect(isCollabMember(member, collab)).toBe(true)
    expect(canViewCollab(member, collab)).toBe(true)
    expect(canViewCollab(outsider, collab)).toBe(false)
    expect(canViewCollab({ ...outsider, roles: ["admin"] }, collab)).toBe(true)
    expect(canViewCollab({ ...member, status: "suspended" }, collab)).toBe(false)
  })

  it("only members edit a launch, and only while it is being set up", () => {
    expect(canEditLaunch(member, { ...collab, status: "draft" })).toBe(true)
    expect(canEditLaunch(member, { ...collab, status: "pending_approval" })).toBe(true)
    expect(canEditLaunch(member, { ...collab, status: "live" })).toBe(false)
    expect(canEditLaunch(outsider, { ...collab, status: "draft" })).toBe(false)
    expect(canEditLaunch({ ...outsider, roles: ["admin"] }, { ...collab, status: "draft" })).toBe(
      false,
    )
  })
})

describe("canSendProposal", () => {
  const builder = authUser({
    roles: ["builder"],
    activeRole: "builder",
    onboardingCompletedAt: ONBOARDED,
  })
  const idea = { kind: "idea", ownerUserId: OTHER_USER_ID, ownerStatus: "active" } as const

  it("lets an onboarded builder pitch on another user's idea", () => {
    expect(canSendProposal(builder, idea)).toBe(true)
  })

  it("requires the counterpart role: creators propose on products, builders on ideas", () => {
    expect(canSendProposal(builder, { ...idea, kind: "product" })).toBe(false)
    const creator = { ...builder, roles: ["creator"] as const }
    expect(canSendProposal(creator, { ...idea, kind: "product" })).toBe(true)
  })

  it("is blocked before onboarding is complete (§12)", () => {
    expect(canSendProposal({ ...builder, onboardingCompletedAt: null }, idea)).toBe(false)
  })

  it("is blocked for yourself, suspended senders and suspended owners", () => {
    expect(canSendProposal(builder, { ...idea, ownerUserId: builder.id })).toBe(false)
    expect(canSendProposal({ ...builder, status: "suspended" }, idea)).toBe(false)
    expect(canSendProposal(builder, { ...idea, ownerStatus: "suspended" })).toBe(false)
  })
})
