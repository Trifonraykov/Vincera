import { readdirSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  activeTab,
  adminNav,
  appNav,
  appTabs,
  isActiveItem,
  isActivePath,
  isBuiltRoute,
  LEGAL_NAV,
  marketingNav,
  ME_PATH,
  mePageSections,
  MOBILE_TAB_COUNT,
  navHrefs,
  plannedNavItem,
  SETTINGS_NAV,
  shellBackHref,
  shellTitle,
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
  // Beyond §12: the audit log page (§14; CLAUDE.md §19.38).
  "/admin/audit",
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

  it("shows v1 routes once their page is built (§19.43), and always with includeV1", () => {
    const visible = [
      ...navHrefs(appNav("creator")),
      ...navHrefs(appNav("builder")),
      ...navHrefs(adminNav()),
      ...marketingNav().map((l) => l.href),
    ]
    for (const route of V1_ROUTES) {
      expect(all).toContain(route)
      if (isBuiltRoute(route)) expect(visible).toContain(route)
      else expect(visible).not.toContain(route)
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

  it("gives phones five tabs per role: Home, three built pages, Me", () => {
    const pages = staticPagePaths()
    for (const role of ["creator", "builder"] as const) {
      const tabs = appTabs(role)
      const hrefs = tabs.map((tab) => tab.href)
      expect(hrefs).toHaveLength(MOBILE_TAB_COUNT)
      expect(hrefs[0]).toBe("/app")
      expect(hrefs.at(-1)).toBe(ME_PATH)
      expect(new Set(hrefs).size).toBe(hrefs.length)
      for (const tab of tabs) {
        // A tab never leads to a 404 (the page exists in this build).
        expect(pages).toContain(tab.href)
        if (tab.id === "me") continue
        expect(SPEC_ROUTES).toContain(tab.href)
        expect(navHrefs(appNav(role))).toContain(tab.href)
      }
    }
    // Discover, Collabs and Inbox take the middle slots once built; until then the role's next
    // built pages stand in, in this order (Phase 2 supply added Ideas and Products).
    const preference: Record<"creator" | "builder", [string, string][]> = {
      creator: [
        ["Discover", "/app/discover"],
        ["Collabs", "/app/collabs"],
        ["Inbox", "/app/messages"],
        ["Audience", "/app/audience"],
        ["Ideas", "/app/ideas"],
        ["Proposals", "/app/proposals"],
        ["Profile", "/app/settings/profile"],
        ["Payouts", "/app/settings/payouts"],
      ],
      builder: [
        ["Discover", "/app/discover"],
        ["Collabs", "/app/collabs"],
        ["Inbox", "/app/messages"],
        ["Products", "/app/products"],
        ["Proposals", "/app/proposals"],
        ["Profile", "/app/settings/profile"],
        ["Connections", "/app/settings/connections"],
      ],
    }
    for (const role of ["creator", "builder"] as const) {
      const middle = preference[role]
        .filter(([, href]) => isBuiltRoute(href))
        .map(([title]) => title)
        .slice(0, MOBILE_TAB_COUNT - 2)
      expect(appTabs(role).map((tab) => tab.title)).toEqual(["Home", ...middle, "Me"])
    }
    // Once Discover, Collabs and Inbox are built, both roles have the final five tabs.
    if (["/app/discover", "/app/collabs", "/app/messages"].every(isBuiltRoute)) {
      for (const role of ["creator", "builder"] as const) {
        expect(appTabs(role).map((tab) => tab.title)).toEqual([
          "Home",
          "Discover",
          "Collabs",
          "Inbox",
          "Me",
        ])
      }
    }
  })

  it("reaches every §12 app destination on a phone, through a tab or the Me page", () => {
    for (const role of ["creator", "builder"] as const) {
      for (const includeV1 of [false, true]) {
        const tabs = appTabs(role).map((tab) => tab.href)
        const me = mePageSections(role, { includeV1 }).flatMap((section) =>
          section.items.map((item) => item.href),
        )
        const onPhone = new Set([...tabs, ...me])
        // Every sidebar item (built or "Soon") and every settings page is one tap from a tab.
        for (const item of appNav(role, { includeV1 }).flatMap((section) => section.items)) {
          expect([role, item.href, onPhone.has(item.href)]).toEqual([role, item.href, true])
        }
        for (const link of SETTINGS_NAV) expect(me).toContain(link.href)
        // Me does not repeat the tabs (settings pages excepted: they are one group).
        for (const href of me.filter((href) => !href.startsWith("/app/settings/"))) {
          expect(tabs).not.toContain(href)
        }
      }
    }
    // The role's own pages: creators reach Ideas, builders Products (a tab or on Me); both reach
    // the shared ones.
    const onPhone = (role: "creator" | "builder") => [
      ...appTabs(role).map((tab) => tab.title),
      ...mePageSections(role).flatMap((section) => section.items.map((item) => item.title)),
    ]
    expect(onPhone("creator")).toEqual(
      expect.arrayContaining(["Ideas", "Discover", "Proposals", "Collabs", "Launches"]),
    )
    expect(onPhone("builder")).toEqual(
      expect.arrayContaining(["Products", "Discover", "Proposals", "Notifications", "Earnings"]),
    )
    const builderMe = mePageSections("builder").flatMap((section) => section.items)
    expect(builderMe.map((item) => item.href)).not.toContain("/app/audience")
  })

  it("lights up the tab a page belongs to, and Me for everything else in the app", () => {
    const tabs = appTabs("creator")
    // The tab that owns a page when it is one of the tabs right now, else Me.
    const owner = (href: string, title: string) =>
      tabs.some((tab) => tab.href === href) ? title : "Me"
    expect(activeTab("/app", tabs)?.title).toBe("Home")
    expect(activeTab("/app/audience", tabs)?.title).toBe(owner("/app/audience", "Audience"))
    expect(activeTab("/app/ideas/0190", tabs)?.title).toBe(owner("/app/ideas", "Ideas"))
    expect(activeTab("/app/settings/payouts", tabs)?.title).toBe(
      owner("/app/settings/payouts", "Payouts"),
    )
    expect(activeTab("/app/settings/account", tabs)?.title).toBe("Me")
    expect(activeTab("/app/me", tabs)?.title).toBe("Me")
    expect(activeTab("/app/collabs/0190/tasks", tabs)?.title).toBe(owner("/app/collabs", "Collabs"))
    expect(activeTab("/app/discover/briefs", tabs)?.title).toBe(owner("/app/discover", "Discover"))
    expect(activeTab("/admin", tabs)).toBeNull()
    expect(activeTab("/application", tabs)).toBeNull()
  })

  it("titles the phone app bar from the menus", () => {
    expect(shellTitle("/app")).toBe("Home")
    expect(shellTitle("/app/me")).toBe("Me")
    expect(shellTitle("/app/settings/payouts")).toBe("Payouts")
    expect(shellTitle("/app/settings/account")).toBe("Account")
    expect(shellTitle("/app/discover/briefs")).toBe("Briefs")
    expect(shellTitle("/app/earnings")).toBe("Earnings")
    expect(shellTitle("/app/earnings/payouts")).toBe("Payouts")
    expect(shellTitle("/app/collabs/0190/agreement")).toBe("Collabs")
    expect(shellTitle("/admin/users/0190")).toBe("Users")
    expect(shellTitle("/admin")).toBe("Overview")
    expect(shellTitle("/app/nope")).toBeNull()
  })

  it("puts a back button on nested pages, to the nearest page that exists", () => {
    const tabs = appTabs("builder")
    // Tabs and section roots have none.
    expect(shellBackHref("/app", tabs)).toBeNull()
    expect(shellBackHref(ME_PATH, tabs)).toBeNull()
    for (const tab of tabs) expect(shellBackHref(tab.href, tabs)).toBeNull()
    expect(shellBackHref("/admin", tabs)).toBeNull()
    expect(shellBackHref("/admin/users", tabs)).toBeNull()
    // Settings and the app's own sections are listed on Me.
    expect(shellBackHref("/app/settings/account", tabs)).toBe(ME_PATH)
    expect(shellBackHref("/app/audience", tabs)).toBe(ME_PATH)
    // Nested pages go up; dynamic parents (ids) are assumed to exist, unbuilt menu pages skipped.
    expect(shellBackHref("/app/collabs/0190/tasks", tabs)).toBe("/app/collabs/0190")
    expect(shellBackHref("/app/collabs/0190", tabs)).toBe(
      isBuiltRoute("/app/collabs") ? "/app/collabs" : ME_PATH,
    )
    expect(shellBackHref("/app/discover/creators", tabs)).toBe(
      isBuiltRoute("/app/discover") ? "/app/discover" : ME_PATH,
    )
    // An admin detail page goes back to its list once that list is built (Phase 6).
    expect(shellBackHref("/admin/users/0190", tabs)).toBe(
      isBuiltRoute("/admin/users") ? "/admin/users" : null,
    )
    expect(shellBackHref("/c/ada", tabs)).toBeNull()
  })

  it("names the menu item of a page a later phase builds, for the shell's coming-soon page", () => {
    // Discover is built (Phase 2): its pages are not "coming soon".
    expect(plannedNavItem("/app/discover")).toBeNull()
    expect(plannedNavItem("/app/discover/briefs")).toBeNull()
    expect(plannedNavItem("/app/launches/0190/kit")?.title).toBe(
      isBuiltRoute("/app/launches") ? undefined : "Launches",
    )
    expect(plannedNavItem("/app/collabs/0190/agreement")?.title).toBe(
      isBuiltRoute("/app/collabs") ? undefined : "Collabs",
    )
    expect(plannedNavItem("/app/earnings/payouts")?.title).toBe(
      isBuiltRoute("/app/earnings") ? undefined : "Earnings",
    )
    expect(plannedNavItem("/admin/users")?.title).toBe(
      isBuiltRoute("/admin/users") ? undefined : "Users",
    )
    // Built pages and unknown paths are not "coming soon".
    expect(plannedNavItem("/app")).toBeNull()
    expect(plannedNavItem("/app/ideas/new")).toBeNull()
    expect(plannedNavItem("/app/notifications")).toBeNull()
    expect(plannedNavItem("/app/proposals/new")).toBeNull()
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
