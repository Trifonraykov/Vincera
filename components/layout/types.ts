import type { ActionResult } from "@/lib/actions/result"
import type { AppRole } from "@/lib/nav"

/** What the app and admin shells need to know about the signed-in user. Presentational only. */
export type ShellUser = {
  id: string
  name: string | null
  email: string
  image: string | null
}

/** Server actions the layouts pass into the shell (lib/users/actions.ts, lib/auth/actions.ts). */
export type ShellActions = {
  /** Sets `users.active_role`; the server revalidates the app layout. */
  switchRole?: (input: { role: AppRole }) => Promise<ActionResult<unknown>>
  /** Ends the session (Auth.js `signOut`). Used as a `<form action>`. */
  signOut?: () => Promise<void>
}

export type ShellProps = ShellActions & {
  variant: "app" | "admin"
  appName: string
  user: ShellUser | null
  /** Roles the user has (from `users.roles`, admin excluded). */
  roles: readonly AppRole[]
  activeRole: AppRole
  isAdmin: boolean
  unreadNotifications?: number
  /** Desktop sidebar open state, from the `sidebar_state` cookie. */
  defaultSidebarOpen?: boolean
  /** Show Phase 7 (v1) routes. */
  includeV1?: boolean
}
