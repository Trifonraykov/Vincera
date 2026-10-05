import {
  Banknote,
  Bell,
  Compass,
  Handshake,
  House,
  LayoutDashboard,
  Lightbulb,
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

const ROLE_ITEMS: Record<AppRole, NavItem[]> = {
  creator: [
    { title: "Home", href: "/app", icon: House },
    { title: "Audience", href: "/app/audience", icon: Users },
    { title: "Ideas", href: "/app/ideas", icon: Lightbulb },
  ],
  builder: [
    { title: "Home", href: "/app", icon: House },
    { title: "Products", href: "/app/products", icon: Package },
  ],
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

/** All hrefs in a set of sections, children included (tests and sitemaps). */
export function navHrefs(sections: NavSection[]): string[] {
  return sections.flatMap((section) =>
    section.items.flatMap((item) => [item.href, ...(item.children ?? []).map((c) => c.href)]),
  )
}
