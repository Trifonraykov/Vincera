import {
  Activity,
  Banknote,
  Bell,
  BellRing,
  CircleUser,
  Compass,
  Handshake,
  House,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Lightbulb,
  Link2,
  ListChecks,
  MessagesSquare,
  Package,
  Rocket,
  Scale,
  Send,
  Settings,
  Sparkles,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react"

/**
 * Navigation: the single source of truth for every menu (§12 routes, exactly).
 * Items marked `v1` belong to Phase 7 and are hidden unless `includeV1` is set.
 */

/** The role the app is currently acting as (`users.active_role`). */
export type AppRole = "creator" | "builder"
export const APP_ROLES = ["creator", "builder"] as const satisfies readonly AppRole[]

export const ROLE_LABELS: Record<AppRole, string> = {
  creator: "Creator",
  builder: "Builder",
}

export type NavLink = {
  title: string
  href: string
  /** Phase 7 route; hidden unless v1 is enabled. */
  v1?: boolean
}

export type NavItem = NavLink & {
  icon: LucideIcon
  /** Path prefix that marks the item active, when it differs from `href`. */
  match?: string
  /** Shown under the item while it is active. */
  children?: NavLink[]
}

export type NavSection = {
  label: string
  items: NavItem[]
}

type NavOptions = { includeV1?: boolean }

// --- Marketing ------------------------------------------------------------------------------

export const MARKETING_NAV: NavLink[] = [
  { title: "For creators", href: "/creators" },
  { title: "For builders", href: "/builders" },
  { title: "How it works", href: "/how-it-works" },
  { title: "Pricing", href: "/pricing" },
  { title: "Launches", href: "/launches", v1: true },
]

export const LEGAL_NAV: NavLink[] = [
  { title: "Terms", href: "/legal/terms" },
  { title: "Privacy", href: "/legal/privacy" },
  { title: "Collaboration agreement", href: "/legal/agreement" },
]

export const AUTH_LINKS = {
  signIn: "/sign-in",
  signUp: "/sign-up",
} as const

// --- App ------------------------------------------------------------------------------------

const HOME: NavItem = { title: "Home", href: "/app", icon: House }
const AUDIENCE: NavItem = { title: "Audience", href: "/app/audience", icon: Users }
const PRODUCTS: NavItem = { title: "Products", href: "/app/products", icon: Package }

const ROLE_ITEMS: Record<AppRole, NavItem[]> = {
  creator: [HOME, AUDIENCE, { title: "Ideas", href: "/app/ideas", icon: Lightbulb }],
  builder: [HOME, PRODUCTS],
}

const DISCOVER_CHILDREN: Record<AppRole, NavLink[]> = {
  creator: [
    { title: "Builders", href: "/app/discover/builders" },
    { title: "Saved", href: "/app/discover/saved", v1: true },
  ],
  builder: [
    { title: "Creators", href: "/app/discover/creators" },
    { title: "Briefs", href: "/app/discover/briefs" },
    { title: "Saved", href: "/app/discover/saved", v1: true },
  ],
}

function sharedItems(role: AppRole): NavItem[] {
  return [
    { title: "Discover", href: "/app/discover", icon: Compass, children: DISCOVER_CHILDREN[role] },
    { title: "Proposals", href: "/app/proposals", icon: Send },
    { title: "Collabs", href: "/app/collabs", icon: Handshake },
    { title: "Launches", href: "/app/launches", icon: Rocket },
  ]
}

const INBOX_ITEMS: NavItem[] = [
  { title: "Messages", href: "/app/messages", icon: MessagesSquare },
  { title: "Notifications", href: "/app/notifications", icon: Bell },
]

/** Settings pages (§12), in the sidebar under "Settings" and as tabs on every settings page. */
export const SETTINGS_NAV: NavLink[] = [
  { title: "Profile", href: "/app/settings/profile" },
  { title: "Connections", href: "/app/settings/connections" },
  { title: "Payouts", href: "/app/settings/payouts" },
  { title: "Notifications", href: "/app/settings/notifications" },
  { title: "Account", href: "/app/settings/account" },
]

const ACCOUNT_ITEMS: NavItem[] = [
  {
    title: "Earnings",
    href: "/app/earnings",
    icon: Wallet,
    children: [
      { title: "Overview", href: "/app/earnings" },
      { title: "Payouts", href: "/app/earnings/payouts" },
    ],
  },
  {
    title: "Settings",
    href: "/app/settings/profile",
    match: "/app/settings",
    icon: Settings,
    children: SETTINGS_NAV,
  },
]

/** Sidebar sections for the signed-in app, for the active role. */
export function appNav(role: AppRole, options: NavOptions = {}): NavSection[] {
  return filterSections(
    [
      { label: ROLE_LABELS[role], items: ROLE_ITEMS[role] },
      { label: "Collaborate", items: sharedItems(role) },
      { label: "Inbox", items: INBOX_ITEMS },
      { label: "Account", items: ACCOUNT_ITEMS },
    ],
    options,
  )
}

// --- Mobile app shell ----------------------------------------------------------------------

/**
 * The bottom tab bar on phones (components/layout/mobile-tab-bar.tsx), like a native app's tabs:
 * Home, Discover, Collabs, Inbox and Me. "Me" (`/app/me`) lists everything else for the role
 * (`mePageSections`), so every `appNav` item stays reachable on a phone without the sidebar.
 *
 * Only built pages become tabs (`isBuiltRoute`), so a tab never leads to a "coming soon" page.
 * While Discover, Collabs or Inbox are not built yet, the role's next pages fill their slots, in
 * order of preference (`MOBILE_TAB_FALLBACKS`); in Phase 1 that is Audience, Profile and Payouts
 * for creators and Profile, Connections and Payouts for builders. As later phases add their pages
 * to BUILT_ROUTES, the bar becomes Home, Discover, Collabs, Inbox, Me by itself.
 */
export type MobileTabId = "home" | "discover" | "collabs" | "inbox" | "me" | "page"

export type MobileTab = NavItem & {
  id: MobileTabId
  /** Other paths that light the tab up (Inbox: notifications next to messages). */
  alsoMatches?: string[]
  /** The tab shows the shell's unread count (Inbox). */
  showsUnread?: boolean
}

export const ME_PATH = "/app/me"
export const MOBILE_TAB_COUNT = 5

const ME_TAB: MobileTab = { id: "me", title: "Me", href: ME_PATH, icon: CircleUser }

/** The three middle slots, in order: the finished app's tabs. */
const MOBILE_TAB_SLOTS: MobileTab[] = [
  { id: "discover", title: "Discover", href: "/app/discover", icon: Compass },
  { id: "collabs", title: "Collabs", href: "/app/collabs", icon: Handshake },
  {
    id: "inbox",
    title: "Inbox",
    href: "/app/messages",
    icon: Inbox,
    alsoMatches: ["/app/notifications"],
    showsUnread: true,
  },
]

/** Pages that stand in for unbuilt slots, per role, in order of preference. */
const MOBILE_TAB_FALLBACKS: Record<AppRole, MobileTab[]> = {
  creator: [
    { id: "page", ...AUDIENCE },
    { id: "page", title: "Ideas", href: "/app/ideas", icon: Lightbulb },
    { id: "page", title: "Proposals", href: "/app/proposals", icon: Send },
    { id: "page", title: "Profile", href: "/app/settings/profile", icon: UserRound },
    { id: "page", title: "Payouts", href: "/app/settings/payouts", icon: Banknote },
    { id: "page", title: "Connections", href: "/app/settings/connections", icon: Link2 },
  ],
  builder: [
    { id: "page", ...PRODUCTS },
    { id: "page", title: "Proposals", href: "/app/proposals", icon: Send },
    { id: "page", title: "Profile", href: "/app/settings/profile", icon: UserRound },
    { id: "page", title: "Connections", href: "/app/settings/connections", icon: Link2 },
    { id: "page", title: "Payouts", href: "/app/settings/payouts", icon: Banknote },
  ],
}

/** The phone tab bar for the active role: Home, three built pages, Me. */
export function appTabs(role: AppRole): MobileTab[] {
  const middle = [...MOBILE_TAB_SLOTS, ...MOBILE_TAB_FALLBACKS[role]]
    .filter((tab) => isBuiltRoute(tab.href))
    .slice(0, MOBILE_TAB_COUNT - 2)
  return [{ id: "home", ...HOME }, ...middle, ME_TAB]
}

/**
 * The tab a path belongs to: the tab whose page (or `alsoMatches`) contains it, else Me, which
 * holds every other page of the app (`/app` itself is Home). Null outside the app.
 */
export function activeTab(pathname: string, tabs: readonly MobileTab[]): MobileTab | null {
  if (pathname !== "/app" && !pathname.startsWith("/app/")) return null
  const owner = tabs.find(
    (tab) =>
      tab.id !== "me" &&
      [tab.href, ...(tab.alsoMatches ?? [])].some((href) => isActivePath(pathname, href)),
  )
  return owner ?? tabs.find((tab) => tab.id === "me") ?? null
}

export type MeSection = {
  label: string
  items: NavItem[]
}

/**
 * What the Me page lists for the role: every sidebar item that is not a tab right now (built or
 * "Soon"), and all the settings pages. With the tab bar this covers every `appNav` link, so a phone
 * reaches each §12 page of the app (tests/unit/nav.test.ts checks it).
 */
export function mePageSections(role: AppRole, options: NavOptions = {}): MeSection[] {
  const tabHrefs = new Set(appTabs(role).map((tab) => tab.href))
  const sections: MeSection[] = appNav(role, options)
    .map((section) => ({
      label: section.label,
      items: section.items.filter(
        (item) => item.href !== "/app/settings/profile" && !tabHrefs.has(item.href),
      ),
    }))
    .filter((section) => section.items.length > 0)
  const settings: MeSection = {
    label: "Settings",
    items: SETTINGS_NAV.map((link) => ({
      ...link,
      icon: SETTINGS_ICONS[link.href] ?? Settings,
    })),
  }
  return [...sections, settings]
}

const SETTINGS_ICONS: Record<string, LucideIcon> = {
  "/app/settings/profile": UserRound,
  "/app/settings/connections": Link2,
  "/app/settings/payouts": Banknote,
  "/app/settings/notifications": BellRing,
  "/app/settings/account": KeyRound,
}

/**
 * The phone app bar's default title for a path: the deepest menu entry that contains it (Settings →
 * Payouts is "Payouts", `/app/collabs/<id>` is "Collabs"). Pages with a more specific title set it
 * with `<AppBarSlot title>` (components/layout/app-bar-slot.tsx). Null when no menu knows the path.
 */
export function shellTitle(pathname: string): string | null {
  if (pathname === ME_PATH) return ME_TAB.title
  const sections = [
    ...APP_ROLES.flatMap((role) => appNav(role, { includeV1: true })),
    ...adminNav({ includeV1: true }),
  ]
  const candidates = sections
    .flatMap((section) => section.items)
    .flatMap((item) => [
      { title: item.title, href: item.href },
      // A child that is its parent's own page (Earnings → Overview) keeps the parent's title.
      ...(item.children ?? []).map((child) => ({
        title: child.href === item.href ? item.title : child.title,
        href: child.href,
      })),
    ])
    .filter((candidate) => isActivePath(pathname, candidate.href))
  let best: { title: string; href: string } | null = null
  for (const candidate of candidates) {
    if (!best || candidate.href.length > best.href.length) best = candidate
  }
  return best?.title ?? null
}

/**
 * Where the phone app bar's back button goes, or null for pages without one: tabs, `/admin` and
 * admin sections (the menu button opens the admin menu instead). Otherwise the nearest parent page
 * that exists, and Me for the app's own sections and settings (Me lists them). Pages can set
 * another target with `<AppBarSlot back>`.
 */
export function shellBackHref(pathname: string, tabs: readonly MobileTab[]): string | null {
  if (tabs.some((tab) => tab.href === pathname)) return null
  const root = pathname.startsWith("/admin") ? "/admin" : "/app"
  if (pathname === root || !pathname.startsWith(`${root}/`)) return null
  let parent = pathname.slice(0, pathname.lastIndexOf("/"))
  while (parent !== root && parent.startsWith(`${root}/`)) {
    if (parent === "/app/settings") return ME_PATH
    // Skip menu pages a later phase builds; dynamic pages (ids) are assumed to exist.
    if (isBuiltRoute(parent) || !menuHrefs().has(parent)) return parent
    parent = parent.slice(0, parent.lastIndexOf("/"))
  }
  return root === "/app" ? ME_PATH : null
}

// --- Built routes ---------------------------------------------------------------------------

/**
 * The menu pages that exist in this build. §12's other routes arrive phase by phase: menus show
 * them as "Soon" without a link, the tab bar and the home page skip them, and a URL typed by hand
 * gets the shell's "Coming soon" page (app/app/not-found.tsx). tests/unit/nav.test.ts compares this
 * list with the `page.tsx` files under app/, so a phase that adds a page must add it here.
 */
const BUILT_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/creators",
  "/builders",
  "/how-it-works",
  "/pricing",
  "/legal/terms",
  "/legal/privacy",
  "/legal/agreement",
  "/app",
  "/app/audience",
  "/app/me",
  "/app/settings/profile",
  "/app/settings/connections",
  "/app/settings/payouts",
  "/app/settings/notifications",
  "/app/settings/account",
  "/admin",
])

/** Whether the page at `href` (a menu path, without query or hash) exists in this build. */
export function isBuiltRoute(href: string): boolean {
  return BUILT_ROUTES.has(href)
}

// --- Admin ----------------------------------------------------------------------------------

const ADMIN_SECTIONS: NavSection[] = [
  {
    label: "Admin",
    items: [
      { title: "Overview", href: "/admin", icon: LayoutDashboard },
      { title: "Users", href: "/admin/users", icon: Users },
      { title: "Collabs", href: "/admin/collabs", icon: Handshake },
      { title: "Launches", href: "/admin/launches", icon: ListChecks },
      { title: "Disputes", href: "/admin/disputes", icon: Scale },
      { title: "Payouts", href: "/admin/payouts", icon: Banknote },
    ],
  },
  {
    label: "Insights",
    items: [
      { title: "Events", href: "/admin/events", icon: Activity, v1: true },
      { title: "Matching", href: "/admin/matching", icon: Sparkles, v1: true },
    ],
  },
]

export function adminNav(options: NavOptions = {}): NavSection[] {
  return filterSections(ADMIN_SECTIONS, options)
}

/** Marketing links visible with the given options (drops v1 routes by default). */
export function marketingNav(options: NavOptions = {}): NavLink[] {
  return MARKETING_NAV.filter((link) => options.includeV1 || !link.v1)
}

// --- Helpers --------------------------------------------------------------------------------

function filterSections(sections: NavSection[], { includeV1 = false }: NavOptions): NavSection[] {
  const visible = <T extends NavLink>(link: T) => includeV1 || !link.v1
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter(visible).map((item) => ({
        ...item,
        children: item.children?.filter(visible),
      })),
    }))
    .filter((section) => section.items.length > 0)
}

/** Root routes are only active on an exact match, so `/app` does not light up everywhere. */
const EXACT_ROUTES = new Set(["/", "/app", "/admin"])

export function isActivePath(pathname: string, href: string): boolean {
  if (EXACT_ROUTES.has(href)) return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function isActiveItem(pathname: string, item: Pick<NavItem, "href" | "match">): boolean {
  return isActivePath(pathname, item.match ?? item.href)
}

/**
 * The menu item a path belongs to when that part of the platform is not built yet, e.g.
 * `/app/ideas/new` → Ideas, `/app/discover/briefs` → Discover. Null for built pages and for paths
 * no menu knows (a mistyped URL). The shells' not-found pages use it to say "coming soon" rather
 * than "not found".
 */
export function plannedNavItem(pathname: string): NavItem | null {
  if (isBuiltRoute(pathname)) return null
  const items = [
    ...APP_ROLES.flatMap((role) => appNav(role, { includeV1: true })),
    ...adminNav({ includeV1: true }),
  ].flatMap((section) => section.items)
  let best: { item: NavItem; length: number } | null = null
  for (const item of items) {
    for (const href of [item.href, ...(item.children ?? []).map((child) => child.href)]) {
      if (isBuiltRoute(href) || !isActivePath(pathname, href)) continue
      if (!best || href.length > best.length) best = { item, length: href.length }
    }
  }
  return best?.item ?? null
}

let menuHrefCache: ReadonlySet<string> | null = null

/** Every path any app or admin menu links to, v1 included. */
function menuHrefs(): ReadonlySet<string> {
  menuHrefCache ??= new Set([
    ...APP_ROLES.flatMap((role) => navHrefs(appNav(role, { includeV1: true }))),
    ...navHrefs(adminNav({ includeV1: true })),
  ])
  return menuHrefCache
}

/** All hrefs in a set of sections, children included (tests and sitemaps). */
export function navHrefs(sections: NavSection[]): string[] {
  return sections.flatMap((section) =>
    section.items.flatMap((item) => [item.href, ...(item.children ?? []).map((c) => c.href)]),
  )
}
