import { redirect } from "next/navigation"

/** §12 has no `/app/settings` page; the menu's "Settings" opens the profile tab (§19.8). */
export default function SettingsIndexPage() {
  redirect("/app/settings/profile")
}
