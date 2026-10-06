import { NativeTabs } from "expo-router/unstable-native-tabs"
import { useEffect } from "react"
import { AppState } from "react-native"

import { useAuth } from "@/lib/auth"
import { useTheme } from "@/ui/theme"

/**
 * The native tab bar (UITabBarController): Home, Feed (creators) or Discover (builders), Collabs,
 * Inbox, Me, the same five as the web's phone layout (CLAUDE.md §19.20, §19.45). Each tab is its
 * own navigation stack (./(home,feed,discover,collabs,inbox,me)/_layout.tsx). Inbox carries the
 * unread count. Creators reach Discover from Me.
 */
export default function TabsLayout() {
  const auth = useAuth()
  const theme = useTheme()
  const creator = auth.status === "signedIn" && auth.me.activeRole === "creator"
  const unread =
    auth.status === "signedIn" ? auth.me.unread.notifications + auth.me.unread.messages : 0

  // Refresh the badge when the app returns to the foreground.
  const { refreshMe } = auth
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshMe().catch(() => undefined)
    })
    return () => subscription.remove()
  }, [refreshMe])

  return (
    <NativeTabs tintColor={theme.tint}>
      <NativeTabs.Trigger name="(home)">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(feed)" hidden={!creator}>
        <NativeTabs.Trigger.Label>Feed</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "flame", selected: "flame.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(discover)" hidden={creator}>
        <NativeTabs.Trigger.Label>Discover</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "safari", selected: "safari.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(collabs)">
        <NativeTabs.Trigger.Label>Collabs</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "person.2", selected: "person.2.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(inbox)">
        <NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "tray", selected: "tray.fill" }} />
        {unread > 0 ? (
          <NativeTabs.Trigger.Badge>
            {unread > 99 ? "99+" : String(unread)}
          </NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(me)">
        <NativeTabs.Trigger.Label>Me</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "person.crop.circle", selected: "person.crop.circle.fill" }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
