import type { Metadata } from "next"

import { NotificationPrefsForm } from "@/components/settings/notification-prefs-form"
import { PageHeader } from "@/components/shared/page-header"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { loadNotificationPrefs } from "@/lib/notifications/prefs"

export const metadata: Metadata = { title: "Notifications" }

/**
 * Settings → Notifications (§12, §5 notification_prefs): email and in-app switches per type.
 * Later phases add their types to the catalog (lib/notifications/types.ts) and they appear here.
 */
export default async function NotificationSettingsPage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canManageOwnAccount(user))
  const prefs = await loadNotificationPrefs(getDb(), user.id)

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader
        title="Notifications"
        description="Choose how we tell you about things that need your attention."
      />
      <NotificationPrefsForm prefs={prefs} />
      <p className="text-sm text-muted-foreground">
        Sign-in links and emails about money you earn or owe are always sent.
      </p>
    </div>
  )
}
