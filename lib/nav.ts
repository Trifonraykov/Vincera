import {
  Banknote,
  Bell,
  CircleUser,
  Compass,
  Handshake,
  House,
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
  Activity,
  Sparkles,
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

/**
 * The bottom tab bar on phones (the app shell's mobile navigation, like a native app's tabs): the
 * role's main page plus the places people return to most. A "More" tab after them opens the full
 * sidebar menu, so every `appNav` item stays one tap away.
 *
 * Candidates are listed in order of preference and only built pages become tabs
 * (`isBuiltRoute`), so a tab never leads to a 404. In Phase 1 that is Home, Audience, Profile and
 * Payouts for creators and Home, Profile, Connections and Payouts for builders; Products, Discover
 * and Collabs take their places as their pages land.
 */
export const MOBILE_TAB_COUNT = 4

const DISCOVER_TAB: NavItem = { title: "Discover", href: "/app/discover", icon: Compass }
const COLLABS_TAB: NavItem = { title: "Collabs", href: "/app/collabs", icon: Handshake }
const PROFILE_TAB: NavItem = { title: "Profile", href: "/app/settings/profile", icon: CircleUser }
const CONNECTIONS_TAB: NavItem = {
  title: "Connections",
  href: "/app/settings/connections",
  icon: Link2,
}
const PAYOUTS_TAB: NavItem = { title: "Payouts", href: "/app/settings/payouts", icon: Banknote }

const MOBILE_TAB_CANDIDATES: Record<AppRole, NavItem[]> = {
  creator: [HOME, AUDIENCE, DISCOVER_TAB, COLLABS_TAB, PROFILE_TAB, PAYOUTS_TAB, CONNECTIONS_TAB],
  builder: [HOME, PRODUCTS, DISCOVER_TAB, COLLABS_TAB, PROFILE_TAB, CONNECTIONS_TAB, PAYOUTS_TAB],
}

export function appTabs(role: AppRole): NavItem[] {
  return MOBILE_TAB_CANDIDATES[role]
    .filter((tab) => isBuiltRoute(tab.href))
    .slice(0, MOBILE_TAB_COUNT)
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

/** All hrefs in a set of sections, children included (tests and sitemaps). */
export function navHrefs(sections: NavSection[]): string[] {
  return sections.flatMap((section) =>
    section.items.flatMap((item) => [item.href, ...(item.children ?? []).map((c) => c.href)]),
  )
}
