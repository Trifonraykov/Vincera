import type { Metadata } from "next"
import { cookies } from "next/headers"
import type { ReactNode } from "react"

import { ImpersonationBanner } from "@/components/admin/impersonation-banner"
import { AppShell } from "@/components/layout/app-shell"
import { toShellViewer } from "@/components/layout/viewer"
import { signOutAction } from "@/lib/auth/actions"
import { getViewer, requireAdmin } from "@/lib/auth/session"
import { env } from "@/lib/env"

export const metadata: Metadata = {
  title: { default: "Admin", template: `%s · Admin · ${env.APP_NAME}` },
  robots: { index: false, follow: false },
}

/**
 * Admin shell (§6, §12). proxy.ts redirects non-admins to /app before this renders;
 * `requireAdmin()` enforces the same rule here (defence in depth).
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const viewer = toShellViewer(await requireAdmin())
  // Admin pages stay usable (read-only) during "view as"; the banner says so (§19.38).
  const { impersonation } = await getViewer()
  const sidebarState = (await cookies()).get("sidebar_state")?.value

  return (
    <AppShell
      variant="admin"
      appName={env.APP_NAME}
      user={viewer.user}
      roles={viewer.roles}
      activeRole={viewer.activeRole}
      isAdmin={viewer.isAdmin}
      signOut={signOutAction}
      defaultSidebarOpen={sidebarState !== "false"}
      banner={impersonation ? <ImpersonationBanner impersonation={impersonation} /> : undefined}
    >
      {children}
    </AppShell>
  )
}
