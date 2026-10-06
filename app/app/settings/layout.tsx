import type { ReactNode } from "react"

import { SettingsNav } from "@/components/layout/settings-nav"

/** Settings (§12): the settings tabs above each settings page. The app layout checks access. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-8">
      <SettingsNav />
      {children}
    </div>
  )
}
