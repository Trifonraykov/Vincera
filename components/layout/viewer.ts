import "server-only"

import { isAdmin } from "@/lib/auth/authz"
import { getCurrentUser } from "@/lib/auth/session"
import { appRolesOf, type AuthUser } from "@/lib/auth/user"
import type { AppRole } from "@/lib/nav"

import type { ShellUser } from "./types"

export type ShellViewer = {
  user: ShellUser
  /** `users.roles` without `admin`. */
  roles: AppRole[]
  activeRole: AppRole
  isAdmin: boolean
}

/** The signed-in user as the app and admin shells need it. */
export function toShellViewer(user: AuthUser): ShellViewer {
  const roles = appRolesOf(user)
  // An admin-only user has no app role yet; the shell still needs one to pick its menus.
  const activeRole = roles.find((role) => role === user.activeRole) ?? roles[0] ?? "creator"
  return {
    user: { id: user.id, name: user.name, email: user.email, image: user.image },
    roles,
    activeRole,
    isAdmin: isAdmin(user),
  }
}

/** The shell viewer for the current request, or null when signed out. */
export async function getShellViewer(): Promise<ShellViewer | null> {
  const user = await getCurrentUser()
  return user ? toShellViewer(user) : null
}
