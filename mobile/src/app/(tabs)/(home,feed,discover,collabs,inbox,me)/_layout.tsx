import { Stack } from "expo-router"

import { useTheme } from "@/ui/theme"

/**
 * One navigation stack per tab, with large titles. The array group gives every tab the same
 * detail screens (an idea, a proposal, a collab…), pushed onto the tab you are in, like the
 * native apps people know (Expo Router "shared routes").
 */
export const unstable_settings = {
  anchor: "home",
  home: { anchor: "home" },
  feed: { anchor: "feed" },
  discover: { anchor: "discover" },
  collabs: { anchor: "collabs" },
  inbox: { anchor: "inbox" },
  me: { anchor: "me" },
}

export default function TabStack() {
  const theme = useTheme()
  return (
    <Stack
      screenOptions={{
        headerLargeTitleEnabled: true,
        headerLargeTitleShadowVisible: false,
        headerShadowVisible: false,
        headerTransparent: false,
        headerStyle: { backgroundColor: theme.background },
        headerTintColor: theme.tint,
        headerTitleStyle: { color: theme.label },
        headerLargeTitleStyle: { color: theme.label },
        contentStyle: { backgroundColor: theme.background },
        headerBackButtonDisplayMode: "minimal",
      }}
    >
      <Stack.Screen name="home" options={{ title: "Home" }} />
      <Stack.Screen name="feed" options={{ title: "For you" }} />
      <Stack.Screen name="discover" options={{ title: "Discover" }} />
      <Stack.Screen name="collabs" options={{ title: "Collabs" }} />
      <Stack.Screen name="inbox" options={{ title: "Inbox" }} />
      <Stack.Screen name="me" options={{ title: "Me" }} />
    </Stack>
  )
}
