import type { Metadata } from "next"
import { cookies } from "next/headers"
import type { ReactNode } from "react"

import { AppShell } from "@/components/layout/app-shell"
import { toShellViewer } from "@/components/layout/viewer"
import { signOutAction } from "@/lib/auth/actions"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { env } from "@/lib/env"
import { countUnreadNotifications } from "@/lib/notifications/center"
import { countUnreadMessages } from "@/lib/threads/queries"
import { switchActiveRole } from "@/lib/users/actions"

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

/**
 * Signed-in app shell (§3, §12). proxy.ts gates `/app/*` first; this layout checks again
 * (signed in, active, onboarding done) next to the data (defence in depth, §6).
 *
 * The shell's counts (CLAUDE.md §19.24): unread in-app notifications (the bell) and unread
 * messages (with them, the Inbox tab's badge). Actions that change them revalidate the `/app`
 * layout, so the counts follow without a reload.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireOnboardedUser()
  const viewer = toShellViewer(user)
  const db = getDb()
  const [cookieStore, unreadNotifications, unreadMessages] = await Promise.all([
    cookies(),
    countUnreadNotifications(db, user.id),
    countUnreadMessages(db, user.id),
  ])
  const sidebarState = cookieStore.get("sidebar_state")?.value

  return (
    <AppShell
      variant="app"
      appName={env.APP_NAME}
      user={viewer.user}
      roles={viewer.roles}
      activeRole={viewer.activeRole}
      isAdmin={viewer.isAdmin}
      switchRole={switchActiveRole}
      signOut={signOutAction}
      defaultSidebarOpen={sidebarState !== "false"}
      unreadNotifications={unreadNotifications}
      unreadMessages={unreadMessages}
    >
      {children}
    </AppShell>
  )
}
