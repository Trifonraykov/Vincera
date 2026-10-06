import { describe, expect, it } from "vitest"

import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  cookieOptions,
  parseAttributionCookie,
  parseRefParam,
  parseVisitorCookie,
} from "@/lib/attribution/cookie"
import { isAccessToken, newAccessToken } from "@/lib/delivery/token"
import { collabStageForLaunch, launchStatusAfter } from "@/lib/launches/status"
import { takeRateBps } from "@/lib/ledger/split"

/** Pure pieces of the W3 contracts (CLAUDE.md §19.31). */

describe("launch status machine", () => {
  it("resets approvals to draft on save, except a paused launch stays paused", () => {
    expect(launchStatusAfter("draft", "save")).toBe("draft")
    expect(launchStatusAfter("pending_approval", "save")).toBe("draft")
    expect(launchStatusAfter("admin_review", "save")).toBe("draft")
    expect(launchStatusAfter("paused", "save")).toBe("draft")
    expect(launchStatusAfter("paused", "save", { autoApprove: true })).toBe("paused")
    expect(launchStatusAfter("live", "save")).toBeNull()
    expect(launchStatusAfter("ended", "save")).toBeNull()
  })

  it("needs both approvals, then an admin unless AUTO_APPROVE_LAUNCHES", () => {
    expect(launchStatusAfter("draft", "approve")).toBe("pending_approval")
    expect(launchStatusAfter("pending_approval", "approve", { allMembersApproved: true })).toBe(
      "admin_review",
    )
    expect(
      launchStatusAfter("pending_approval", "approve", {
        allMembersApproved: true,
        autoApprove: true,
      }),
    ).toBe("live")
    expect(launchStatusAfter("admin_review", "approve")).toBeNull()
    expect(launchStatusAfter("admin_review", "admin_approve")).toBe("live")
    expect(launchStatusAfter("admin_review", "admin_reject")).toBe("draft")
    expect(launchStatusAfter("pending_approval", "admin_approve")).toBeNull()
  })

  it("pauses, resumes and ends", () => {
    expect(launchStatusAfter("live", "pause")).toBe("paused")
    expect(launchStatusAfter("paused", "approve", { allMembersApproved: true })).toBe("paused")
    expect(launchStatusAfter("paused", "resume")).toBe("live")
    expect(launchStatusAfter("live", "resume")).toBeNull()
    expect(launchStatusAfter("draft", "end")).toBe("ended")
    expect(launchStatusAfter("ended", "end")).toBeNull()
  })

  it("moves the collab stage with the launch", () => {
    expect(collabStageForLaunch("building", "pending_approval")).toBe("launch_review")
    expect(collabStageForLaunch("launch_review", "admin_review")).toBeNull()
    expect(collabStageForLaunch("launch_review", "draft")).toBe("building")
    expect(collabStageForLaunch("launch_review", "live")).toBe("live")
    expect(collabStageForLaunch("live", "paused")).toBeNull()
    expect(collabStageForLaunch("live", "live")).toBeNull()
  })
})

describe("attribution cookie", () => {
  it("keeps only a UUID link id, for 30 days, httpOnly and Lax", () => {
    expect(ATTRIBUTION_COOKIE).toBe("attr")
    expect(ATTRIBUTION_MAX_AGE_SECONDS).toBe(2_592_000)
    expect(parseAttributionCookie("0199B3A0-0000-7000-8000-000000000003")).toBe(
      "0199b3a0-0000-7000-8000-000000000003",
    )
    expect(parseAttributionCookie("abc")).toBeNull()
    expect(parseAttributionCookie(undefined)).toBeNull()
    expect(cookieOptions(true)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 2_592_000,
    })
  })

  it("accepts ?ref= codes and visitor ids of the right shape only", () => {
    expect(parseRefParam("aB3dE5fG")).toBe("aB3dE5fG")
    expect(parseRefParam("aB3dE5f")).toBeNull()
    expect(parseRefParam("aB3dE5f!")).toBeNull()
    expect(parseVisitorCookie("A".repeat(22))).toBe("A".repeat(22))
    expect(parseVisitorCookie("A".repeat(23))).toBeNull()
  })
})

describe("access tokens and take rate", () => {
  it("makes 43-character base64url tokens from 32 random bytes", () => {
    const token = newAccessToken()
    expect(token).toHaveLength(43)
    expect(isAccessToken(token)).toBe(true)
    expect(newAccessToken()).not.toBe(token)
    expect(isAccessToken(`${token}=`)).toBe(false)
  })

  it("turns PLATFORM_TAKE_RATE into basis points", () => {
    expect(takeRateBps(0.1)).toBe(1000)
    expect(takeRateBps(0.075)).toBe(750)
    expect(takeRateBps(0)).toBe(0)
    expect(() => takeRateBps(1.5)).toThrow(RangeError)
  })
})
