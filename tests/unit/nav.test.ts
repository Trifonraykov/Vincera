import { readdirSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  adminNav,
  appNav,
  appTabs,
  isActiveItem,
  isActivePath,
  isBuiltRoute,
  LEGAL_NAV,
  marketingNav,
  MOBILE_TAB_COUNT,
  navHrefs,
  plannedNavItem,
} from "@/lib/nav"

/** URL paths of the static pages under app/ (route groups dropped, dynamic segments skipped). */
function staticPagePaths(): Set<string> {
  const root = path.join(process.cwd(), "app")
  const found = new Set<string>()
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith("[") || entry.name.startsWith("_")) continue
        const group = entry.name.startsWith("(") && entry.name.endsWith(")")
        walk(path.join(dir, entry.name), group ? segments : [...segments, entry.name])
      } else if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(entry.name)) {
        found.add(`/${segments.join("/")}`)
      }
    }
  }
  walk(root, [])
  return found
}

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

  it("knows which menu pages are built: exactly those with a page file under app/", () => {
    const pages = staticPagePaths()
    expect(pages).toContain("/app/settings/profile")
    for (const href of new Set(all))
      expect([href, isBuiltRoute(href)]).toEqual([href, pages.has(href)])
  })

  it("gives phones four tabs per role, built pages only, all of them in the sidebar menu too", () => {
    const pages = staticPagePaths()
    for (const role of ["creator", "builder"] as const) {
      const tabs = appTabs(role).map((tab) => tab.href)
      expect(tabs).toHaveLength(MOBILE_TAB_COUNT)
      expect(tabs[0]).toBe("/app")
      expect(new Set(tabs).size).toBe(tabs.length)
      for (const href of tabs) {
        expect(SPEC_ROUTES).toContain(href)
        expect(navHrefs(appNav(role))).toContain(href)
        // A tab never leads to a 404 (the page exists in this build).
        expect(pages).toContain(href)
      }
    }
    // Phase 1: Products, Discover and Collabs are not built yet, so the next candidates fill in.
    expect(appTabs("creator").map((tab) => tab.title)).toEqual([
      "Home",
      "Audience",
      "Profile",
      "Payouts",
    ])
    expect(appTabs("builder").map((tab) => tab.title)).toEqual([
      "Home",
      "Profile",
      "Connections",
      "Payouts",
    ])
  })

  it("names the menu item of a page a later phase builds, for the shell's coming-soon page", () => {
    expect(plannedNavItem("/app/discover")?.title).toBe("Discover")
    expect(plannedNavItem("/app/discover/briefs")?.title).toBe("Discover")
    expect(plannedNavItem("/app/ideas/new")?.title).toBe("Ideas")
    expect(plannedNavItem("/app/collabs/0190/agreement")?.title).toBe("Collabs")
    expect(plannedNavItem("/app/earnings/payouts")?.title).toBe("Earnings")
    expect(plannedNavItem("/app/notifications")?.title).toBe("Notifications")
    expect(plannedNavItem("/admin/users")?.title).toBe("Users")
    // Built pages and unknown paths are not "coming soon".
    expect(plannedNavItem("/app")).toBeNull()
    expect(plannedNavItem("/app/settings/payouts")).toBeNull()
    expect(plannedNavItem("/app/settings/nope")).toBeNull()
    expect(plannedNavItem("/app/nope")).toBeNull()
    expect(plannedNavItem("/app/ideasx")).toBeNull()
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
