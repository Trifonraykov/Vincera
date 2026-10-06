import { meSchema } from "@shared/schemas"
import Constants from "expo-constants"
import { router } from "expo-router"
import * as WebBrowser from "expo-web-browser"
import { Alert, StyleSheet, Text, View } from "react-native"

import { api, errorMessage } from "@/lib/api"
import { useAuth, useMe } from "@/lib/auth"
import { API_URL } from "@/lib/config"
import { selectionTick } from "@/lib/haptics"
import { Padded, Row, Screen, Section, Segmented } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * Me (§19.20's Me page, natively): who you are, the role you act as, your pages (profile,
 * ideas or products, audience, earnings), settings on the web, and sign out.
 */
export default function MeScreen() {
  const me = useMe()
  const auth = useAuth()
  const theme = useTheme()
  const appRoles = me.roles.filter(
    (role): role is "creator" | "builder" => role === "creator" || role === "builder",
  )
  const profile = me.activeRole === "builder" ? me.profiles.builder : me.profiles.creator
  const web = (path: string) => () => void WebBrowser.openBrowserAsync(`${me.webUrl}${path}`)

  async function switchRole(role: "creator" | "builder") {
    try {
      const updated = await api(meSchema, "POST", "/me/active-role", { role })
      selectionTick()
      auth.setMe(updated)
    } catch (error) {
      Alert.alert("Couldn't switch roles", errorMessage(error))
    }
  }

  return (
    <Screen>
      <Padded style={styles.header}>
        <View style={[styles.avatar, { backgroundColor: theme.tint }]}>
          <Text style={styles.initial}>
            {(profile?.displayName ?? me.name ?? me.email).slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <Text style={[styles.name, { color: theme.label }]}>
          {profile?.displayName ?? me.name ?? "You"}
        </Text>
        <Text style={{ color: theme.secondaryLabel }}>
          {profile ? `@${profile.handle} · ` : ""}
          {me.email}
        </Text>
      </Padded>

      {appRoles.length > 1 ? (
        <Section
          title="Acting as"
          footer="Home, Discover and your lists follow the role you act as."
        >
          <Padded>
            <Segmented
              options={appRoles.map((role) => ({
                value: role,
                label: role === "creator" ? "Creator" : "Builder",
              }))}
              value={me.activeRole === "builder" ? "builder" : "creator"}
              onChange={(role) => void switchRole(role)}
            />
          </Padded>
        </Section>
      ) : null}

      <Section title="Your work">
        {me.roles.includes("creator") ? (
          <>
            <Row icon="lightbulb" title="My ideas" onPress={() => router.push("/ideas")} />
            <Row icon="chart.bar" title="Audience" onPress={() => router.push("/audience")} />
          </>
        ) : null}
        {me.roles.includes("builder") ? (
          <Row icon="shippingbox" title="My products" onPress={() => router.push("/products")} />
        ) : null}
        <Row icon="paperplane" title="Proposals" onPress={() => router.push("/proposals")} />
        <Row
          icon="eurosign.circle"
          title="Earnings"
          onPress={() => router.push("/earnings")}
          last
        />
      </Section>

      <Section title="Settings">
        <Row icon="person.crop.circle" title="Profile" onPress={() => router.push("/profile")} />
        <Row
          icon="link"
          title="Connections"
          subtitle="On the web"
          onPress={web("app/settings/connections")}
        />
        <Row
          icon="banknote"
          title="Payouts"
          subtitle="On the web (Stripe)"
          onPress={web("app/settings/payouts")}
        />
        <Row
          icon="bell.badge"
          title="Notification settings"
          subtitle="On the web"
          onPress={web("app/settings/notifications")}
        />
        <Row
          icon="gearshape"
          title="Account"
          subtitle="On the web"
          onPress={web("app/settings/account")}
          last
        />
      </Section>

      <Section
        footer={`Vincera ${Constants.expoConfig?.version ?? ""} · ${API_URL.replace(/^https?:\/\//, "")}`}
      >
        <Row
          icon="rectangle.portrait.and.arrow.right"
          iconColor={theme.destructive}
          title="Sign out"
          destructive
          onPress={() =>
            Alert.alert("Sign out?", "You can sign in again with a code from your email.", [
              { text: "Cancel", style: "cancel" },
              { text: "Sign out", style: "destructive", onPress: () => void auth.signOut() },
            ])
          }
          last
        />
      </Section>
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: { alignItems: "center", gap: SPACING.xs, paddingTop: SPACING.md },
  avatar: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: SPACING.sm,
  },
  initial: { color: "#FFFFFF", fontSize: 32, fontWeight: "600" },
  name: { fontSize: 22, fontWeight: "600" },
})
