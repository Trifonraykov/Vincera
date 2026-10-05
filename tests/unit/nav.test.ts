import { describe, expect, it } from "vitest"

import {
  adminNav,
  appNav,
  isActiveItem,
  isActivePath,
  LEGAL_NAV,
  marketingNav,
  navHrefs,
} from "@/lib/nav"

/** Static routes from CLAUDE.md §12 that menus may link to. */
const SPEC_ROUTES = new Set([
  "/creators",
  "/builders",
  "/how-it-works",
  "/pricing",
  "/launches",
  "/legal/terms",
  "/legal/privacy",
  "/legal/agreement",
  "/app",
  "/app/audience",
  "/app/ideas",
  "/app/products",
  "/app/discover",
  "/app/discover/creators",
  "/app/discover/builders",
  "/app/discover/briefs",
  "/app/discover/saved",
  "/app/proposals",
  "/app/collabs",
  "/app/launches",
  "/app/messages",
  "/app/notifications",
  "/app/earnings",
  "/app/earnings/payouts",
  "/app/settings/profile",
  "/app/settings/connections",
  "/app/settings/payouts",
  "/app/settings/notifications",
  "/app/settings/account",
  "/admin",
  "/admin/users",
  "/admin/collabs",
  "/admin/launches",
  "/admin/disputes",
  "/admin/payouts",
  "/admin/events",
  "/admin/matching",
])

const V1_ROUTES = ["/launches", "/app/discover/saved", "/admin/events", "/admin/matching"]

describe("navigation", () => {
  const all = [
    ...navHrefs(appNav("creator", { includeV1: true })),
    ...navHrefs(appNav("builder", { includeV1: true })),
    ...navHrefs(adminNav({ includeV1: true })),
    ...marketingNav({ includeV1: true }).map((l) => l.href),
    ...LEGAL_NAV.map((l) => l.href),
  ]

  it("only links to §12 routes", () => {
    for (const href of all) expect(SPEC_ROUTES).toContain(href)
  })

  it("hides v1 routes unless enabled", () => {
    const visible = [
      ...navHrefs(appNav("creator")),
      ...navHrefs(appNav("builder")),
      ...navHrefs(adminNav()),
      ...marketingNav().map((l) => l.href),
    ]
    for (const route of V1_ROUTES) {
      expect(visible).not.toContain(route)
      expect(all).toContain(route)
    }
  })

  it("shows role-specific items", () => {
    const creator = navHrefs(appNav("creator"))
    const builder = navHrefs(appNav("builder"))
    expect(creator).toEqual(expect.arrayContaining(["/app/audience", "/app/ideas"]))
    expect(creator).not.toContain("/app/products")
    expect(builder).toContain("/app/products")
    expect(builder).not.toContain("/app/audience")
    for (const shared of ["/app/discover", "/app/proposals", "/app/earnings", "/app/messages"]) {
      expect(creator).toContain(shared)
      expect(builder).toContain(shared)
    }
  })

  it("matches active paths by prefix, with root routes exact", () => {
    expect(isActivePath("/app", "/app")).toBe(true)
    expect(isActivePath("/app/ideas", "/app")).toBe(false)
    expect(isActivePath("/app/ideas/123", "/app/ideas")).toBe(true)
    expect(isActivePath("/app/ideasx", "/app/ideas")).toBe(false)
    expect(isActivePath("/admin/users", "/admin")).toBe(false)
    expect(
      isActiveItem("/app/settings/payouts", {
        href: "/app/settings/profile",
        match: "/app/settings",
      }),
    ).toBe(true)
  })
})
