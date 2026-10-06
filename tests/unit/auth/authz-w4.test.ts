import { describe, expect, it } from "vitest"

import {
  canAdjustLedger,
  canDecideRefundRequest,
  canDeleteOwnAccount,
  canExportOwnData,
  canGrantAdmin,
  canImpersonate,
  canManageMatchingModels,
  canManageUsers,
  canRaiseDispute,
  canResolveDispute,
  canReviewDispute,
  canRevokeAdmin,
  canSuspendUser,
  canViewCollabAnalytics,
  canViewDispute,
  canViewEvents,
  canViewLaunchLinks,
  REFUND_REQUEST_WINDOW_DAYS,
  refundRequestRefusal,
  type AdminTargetUser,
} from "@/lib/auth/authz"

import { authUser, OTHER_USER_ID } from "../../helpers/auth-users"

/** Phase 6–7 rules of the W4 contract (CLAUDE.md §19.38). */

const admin = authUser({ roles: ["admin"] })
const creator = authUser({ id: OTHER_USER_ID, roles: ["creator"] })
const THIRD = "0190a000-0000-7000-8000-000000000003"
const target = (overrides: Partial<AdminTargetUser> = {}): AdminTargetUser => ({
  id: THIRD,
  roles: ["creator"],
  status: "active",
  deletedAt: null,
  ...overrides,
})

describe("admin rules", () => {
  it("are for active admins only", () => {
    const suspendedAdmin = authUser({ roles: ["admin"], status: "suspended" })
    for (const rule of [canManageUsers, canAdjustLedger, canViewEvents, canManageMatchingModels]) {
      expect(rule(admin)).toBe(true)
      expect(rule(creator)).toBe(false)
      expect(rule(suspendedAdmin)).toBe(false)
    }
  })

  it("suspend: not yourself, not deleted accounts, not admins", () => {
    expect(canSuspendUser(admin, target())).toBe(true)
    expect(canSuspendUser(admin, target({ status: "suspended" }))).toBe(true)
    expect(canSuspendUser(admin, target({ id: admin.id }))).toBe(false)
    expect(canSuspendUser(admin, target({ deletedAt: new Date() }))).toBe(false)
    expect(canSuspendUser(admin, target({ roles: ["admin"] }))).toBe(false)
    expect(canSuspendUser(creator, target())).toBe(false)
  })

  it("grant and revoke the admin role", () => {
    expect(canGrantAdmin(admin, target())).toBe(true)
    expect(canGrantAdmin(admin, target({ roles: ["admin"] }))).toBe(false)
    expect(canGrantAdmin(admin, target({ status: "suspended" }))).toBe(false)
    expect(canRevokeAdmin(admin, target({ roles: ["admin"] }))).toBe(true)
    expect(canRevokeAdmin(admin, target({ id: admin.id, roles: ["admin"] }))).toBe(false)
    expect(canRevokeAdmin(creator, target({ roles: ["admin"] }))).toBe(false)
  })

  it("view as: active, not deleted, non-admin accounts other than your own", () => {
    expect(canImpersonate(admin, target())).toBe(true)
    expect(canImpersonate(admin, target({ id: admin.id }))).toBe(false)
    expect(canImpersonate(admin, target({ roles: ["admin", "creator"] }))).toBe(false)
    expect(canImpersonate(admin, target({ status: "suspended" }))).toBe(false)
    expect(canImpersonate(admin, target({ deletedAt: new Date() }))).toBe(false)
    expect(canImpersonate(creator, target())).toBe(false)
  })

  it("disputes move open → in_review → resolved, by admins", () => {
    expect(canReviewDispute(admin, { status: "open" })).toBe(true)
    expect(canReviewDispute(admin, { status: "in_review" })).toBe(false)
    expect(canResolveDispute(admin, { status: "in_review" })).toBe(true)
    expect(canResolveDispute(admin, { status: "open" })).toBe(false)
    expect(canResolveDispute(creator, { status: "in_review" })).toBe(false)
  })

  it("refund requests are decided while pending", () => {
    expect(canDecideRefundRequest(admin, { status: "pending" })).toBe(true)
    expect(canDecideRefundRequest(admin, { status: "declined" })).toBe(false)
    expect(canDecideRefundRequest(creator, { status: "pending" })).toBe(false)
  })
})

describe("trust rules", () => {
  const collab = { memberUserIds: [creator.id, THIRD] }

  it("members raise one unresolved dispute at a time; members and admins see them", () => {
    expect(canRaiseDispute(creator, { ...collab, hasUnresolvedDisputeByUser: false })).toBe(true)
    expect(canRaiseDispute(creator, { ...collab, hasUnresolvedDisputeByUser: true })).toBe(false)
    expect(canRaiseDispute(admin, { ...collab, hasUnresolvedDisputeByUser: false })).toBe(false)
    expect(canViewDispute(creator, collab)).toBe(true)
    expect(canViewDispute(admin, collab)).toBe(true)
    expect(canViewDispute(authUser({ id: "0190a000-0000-7000-8000-0000000000ff" }), collab)).toBe(
      false,
    )
  })

  it("export for active users; delete for active non-admins", () => {
    expect(canExportOwnData(creator)).toBe(true)
    expect(canExportOwnData(authUser({ status: "suspended" }))).toBe(false)
    expect(canDeleteOwnAccount(creator)).toBe(true)
    expect(canDeleteOwnAccount(admin)).toBe(false)
  })
})

describe("analytics and v1 rules", () => {
  it("analytics and links pages follow the collab's visibility", () => {
    const collab = { memberUserIds: [creator.id] }
    expect(canViewCollabAnalytics(creator, collab)).toBe(true)
    expect(canViewCollabAnalytics(admin, collab)).toBe(true)
    expect(canViewCollabAnalytics(authUser({ id: THIRD }), collab)).toBe(false)
    const launch = { ...collab, status: "live" as const, collabStage: "live" as const }
    expect(canViewLaunchLinks(creator, launch)).toBe(true)
    expect(canViewLaunchLinks(authUser({ id: THIRD }), launch)).toBe(false)
  })

  it("buyers may ask for a refund once, within the window, while something is left", () => {
    const paidAt = new Date("2026-10-01T12:00:00Z")
    const order = {
      orderStatus: "paid" as const,
      paidAt,
      amountGrossCents: 1900,
      amountRefundedCents: 0,
      grantRevoked: false,
      hasRequest: false,
    }
    const day = 24 * 60 * 60 * 1000
    const inside = new Date(paidAt.getTime() + REFUND_REQUEST_WINDOW_DAYS * day)
    const outside = new Date(inside.getTime() + 1)
    expect(refundRequestRefusal(order, inside)).toBeNull()
    expect(refundRequestRefusal(order, outside)).toBe("window_closed")
    expect(refundRequestRefusal({ ...order, hasRequest: true }, inside)).toBe("already_requested")
    expect(refundRequestRefusal({ ...order, grantRevoked: true }, inside)).toBe("revoked")
    expect(refundRequestRefusal({ ...order, orderStatus: "disputed" }, inside)).toBe("disputed")
    expect(refundRequestRefusal({ ...order, amountRefundedCents: 1900 }, inside)).toBe(
      "nothing_to_refund",
    )
  })
})
