import type { Metadata } from "next"
import { cookies } from "next/headers"
import type { ReactNode } from "react"

import { AppShell } from "@/components/layout/app-shell"
import { toShellViewer } from "@/components/layout/viewer"
import { signOutAction } from "@/lib/auth/actions"
import { requireOnboardedUser } from "@/lib/auth/session"
import { env } from "@/lib/env"
import { switchActiveRole } from "@/lib/users/actions"

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

/**
 * Signed-in app shell (§3, §12). proxy.ts gates `/app/*` first; this layout checks again
 * (signed in, active, onboarding done) next to the data (defence in depth, §6).
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = toShellViewer(await requireOnboardedUser())
  const sidebarState = (await cookies()).get("sidebar_state")?.value

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
    >
      {children}
    </AppShell>
  )
}
