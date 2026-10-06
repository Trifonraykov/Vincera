import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router"
import * as SplashScreen from "expo-splash-screen"
import { StatusBar } from "expo-status-bar"
import { useEffect } from "react"
import { useColorScheme } from "react-native"

import { AuthProvider, useAuth } from "@/lib/auth"

void SplashScreen.preventAutoHideAsync()

/**
 * The root stack: the sign-in screen while signed out, the tab bar while signed in, and the
 * native sheets (counter-offer, proposal, new task, idea/product editor) presented over the tabs.
 */
function RootStack() {
  const auth = useAuth()
  const signedIn = auth.status === "signedIn"

  useEffect(() => {
    if (auth.status !== "loading") void SplashScreen.hideAsync()
  }, [auth.status])

  if (auth.status === "loading") return null

  const sheet = {
    presentation: "formSheet" as const,
    sheetGrabberVisible: true,
    sheetAllowedDetents: [0.75, 1],
    headerShown: true,
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="counter" options={{ ...sheet, title: "Counter-offer" }} />
        <Stack.Screen name="propose" options={{ ...sheet, title: "Send a proposal" }} />
        <Stack.Screen
          name="new-task"
          options={{ ...sheet, title: "New task", sheetAllowedDetents: [0.6, 1] }}
        />
        <Stack.Screen name="supply-editor" options={{ ...sheet, sheetAllowedDetents: [1] }} />
      </Stack.Protected>
    </Stack>
  )
}

export default function RootLayout() {
  const scheme = useColorScheme()
  return (
    <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
      <AuthProvider>
        <StatusBar style="auto" />
        <RootStack />
      </AuthProvider>
    </ThemeProvider>
  )
}
