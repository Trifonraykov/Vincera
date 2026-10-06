import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  IMPERSONATION_COOKIE,
  signImpersonationCookie,
  verifyImpersonationCookie,
  type ImpersonationClaim,
} from "@/lib/auth/impersonation-cookie"

import { authUser, OTHER_USER_ID } from "../../helpers/auth-users"
import { stubServiceEnv, TEST_AUTH_SECRET } from "../../helpers/service-env"

/** Read-only "view as" (CLAUDE.md §19.38): the signed cookie and the mutation guard. */

const mocks = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  requireUser: vi.fn(),
}))

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "admin_view_as" && mocks.cookie !== undefined ? { value: mocks.cookie } : undefined,
  }),
}))
vi.mock("@/lib/auth/session", () => ({ requireUser: mocks.requireUser }))
vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }))
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }))

const SECRET = "s".repeat(32)
const NOW = new Date("2026-10-06T10:00:00.000Z")
const ADMIN = "0190a000-0000-7000-8000-0000000000aa"
const SESSION = "0190a000-0000-7000-8000-0000000000bb"

function claim(overrides: Partial<ImpersonationClaim> = {}): ImpersonationClaim {
  return {
    sessionId: SESSION,
    adminUserId: ADMIN,
    targetUserId: authUser().id,
    expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    ...overrides,
  }
}

describe("impersonation cookie", () => {
  it("round-trips a claim and refuses tampering, other secrets, expiry and junk", () => {
    const value = signImpersonationCookie(claim(), SECRET)
    expect(IMPERSONATION_COOKIE).toBe("admin_view_as")
    expect(verifyImpersonationCookie(value, SECRET, NOW)).toEqual(claim())
    expect(verifyImpersonationCookie(value, "t".repeat(32), NOW)).toBeNull()
    const swapped = value.replace(authUser().id, OTHER_USER_ID)
    expect(verifyImpersonationCookie(swapped, SECRET, NOW)).toBeNull()
    const later = new Date(NOW.getTime() + 60 * 60 * 1000)
    expect(verifyImpersonationCookie(value, SECRET, later)).toBeNull()
    for (const junk of ["", "v1", "v2.a.b.c.d.e", `${value}.extra`, "x".repeat(500)]) {
      expect(verifyImpersonationCookie(junk, SECRET, NOW)).toBeNull()
    }
  })
})

describe("mutations while viewing as someone else", () => {
  beforeEach(() => {
    stubServiceEnv()
    mocks.cookie = undefined
    mocks.requireUser.mockReset().mockResolvedValue(authUser())
  })

  async function action() {
    const { defineAction } = await import("@/lib/actions/define-action")
    const run = vi.fn(async () => "done")
    const act = defineAction({
      name: "test.mutation",
      input: z.object({}),
      authorize: () => true,
      run,
    })
    return { act, run }
  }

  it("refuses every server action when the cookie names the acting user as its target", async () => {
    const { isMutationBlockedByImpersonation } = await import("@/lib/auth/impersonation")
    mocks.cookie = signImpersonationCookie(
      claim({ expiresAt: new Date(Date.now() + 60_000) }),
      TEST_AUTH_SECRET,
    )
    expect(await isMutationBlockedByImpersonation(authUser())).toBe(true)
    const { act, run } = await action()
    expect(await act({})).toEqual({
      ok: false,
      error: expect.stringMatching(/viewing the app as someone else/),
    })
    expect(run).not.toHaveBeenCalled()
  })

  it("lets actions through without a cookie, with a forged one, or for another user", async () => {
    const { act, run } = await action()
    expect(await act({})).toEqual({ ok: true, data: "done" })
    mocks.cookie = signImpersonationCookie(
      claim({ expiresAt: new Date(Date.now() + 60_000) }),
      "b".repeat(32),
    )
    expect(await act({})).toEqual({ ok: true, data: "done" })
    mocks.cookie = signImpersonationCookie(
      claim({ targetUserId: OTHER_USER_ID, expiresAt: new Date(Date.now() + 60_000) }),
      TEST_AUTH_SECRET,
    )
    expect(await act({})).toEqual({ ok: true, data: "done" })
    expect(run).toHaveBeenCalledTimes(3)
  })
})
