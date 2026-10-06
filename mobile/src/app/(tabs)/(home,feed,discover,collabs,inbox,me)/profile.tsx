import { profileOutput, profileSavedOutput, type ProfileResponse } from "@shared/schemas"
import { Stack } from "expo-router"
import { useState } from "react"
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native"

import { api, ApiError, errorMessage } from "@/lib/api"
import { useAuth, useMe } from "@/lib/auth"
import { notifyError, notifySuccess } from "@/lib/haptics"
import { useApi } from "@/lib/use-api"
import { Button, Field, Loaded, Message, Padded, Screen, Section, Segmented } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * Settings → Profile (§12): the public profile of each role, with the web's form rules (handles,
 * reserved words, topic and skill limits). Lists are comma separated, like the web's tag fields.
 */
export default function ProfileScreen() {
  const me = useMe()
  const state = useApi(() => api(profileOutput, "GET", "/profile"))
  const [tab, setTab] = useState<"creator" | "builder">(
    me.activeRole === "builder" ? "builder" : "creator",
  )
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1 }}
    >
      <Screen>
        <Stack.Screen options={{ title: "Profile", headerLargeTitleEnabled: false }} />
        <Loaded state={state}>
          {(profile) => {
            const tabs = [
              ...(profile.creator ? [{ value: "creator" as const, label: "Creator" }] : []),
              ...(profile.builder ? [{ value: "builder" as const, label: "Builder" }] : []),
            ]
            const current = tabs.some((item) => item.value === tab) ? tab : tabs[0]?.value
            if (!current) {
              return (
                <Message
                  icon="person.crop.circle"
                  title="No profile yet"
                  body="Set up your profile on the web first."
                />
              )
            }
            return (
              <>
                {tabs.length > 1 ? (
                  <Segmented options={tabs} value={current} onChange={setTab} />
                ) : null}
                {current === "creator" && profile.creator ? (
                  <CreatorForm key="creator" initial={profile.creator} onSaved={state.reload} />
                ) : profile.builder ? (
                  <BuilderForm key="builder" initial={profile.builder} onSaved={state.reload} />
                ) : null}
              </>
            )
          }}
        </Loaded>
      </Screen>
    </KeyboardAvoidingView>
  )
}

function useSave(path: string, onSaved: () => void) {
  const { refreshMe } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  async function save(body: unknown) {
    setBusy(true)
    setError(null)
    try {
      const result = await api(profileSavedOutput, "PUT", path, body)
      notifySuccess()
      if (result.changed) {
        onSaved()
        void refreshMe().catch(() => undefined)
      }
      Alert.alert(result.changed ? "Saved" : "Nothing changed")
    } catch (caught) {
      notifyError()
      if (caught instanceof ApiError) setError(caught)
      else Alert.alert("Couldn't save", errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, save }
}

function FormError({ error }: { error: ApiError | null }) {
  const theme = useTheme()
  if (!error) return null
  return <Text style={{ color: theme.destructive }}>{error.message}</Text>
}

function CreatorForm({
  initial,
  onSaved,
}: {
  initial: NonNullable<ProfileResponse["creator"]>
  onSaved: () => void
}) {
  const [form, setForm] = useState({ ...initial, topics: initial.topics.join(", ") })
  const { busy, error, save } = useSave("/profile/creator", onSaved)
  return (
    <Section
      title="Creator profile"
      footer="Shown on your public page /c/handle and used for matching."
    >
      <Padded style={styles.form}>
        <Field
          label="Display name"
          value={form.displayName}
          onChangeText={(displayName) => setForm({ ...form, displayName })}
          error={error?.field("displayName")}
        />
        <Field
          label="Handle"
          value={form.handle}
          onChangeText={(handle) => setForm({ ...form, handle })}
          autoCapitalize="none"
          autoCorrect={false}
          error={error?.field("handle")}
        />
        <Field
          label="Niche"
          value={form.niche}
          onChangeText={(niche) => setForm({ ...form, niche })}
          error={error?.field("niche")}
        />
        <Field
          label="Bio"
          value={form.bio}
          onChangeText={(bio) => setForm({ ...form, bio })}
          multiline
          error={error?.field("bio")}
        />
        <Field
          label="Topics"
          hint="Comma separated, up to 8."
          value={form.topics}
          onChangeText={(topics) => setForm({ ...form, topics })}
          autoCapitalize="none"
          error={error?.field("topics")}
        />
        <Field
          label="Country (2 letters)"
          value={form.country}
          onChangeText={(country) => setForm({ ...form, country })}
          autoCapitalize="characters"
          maxLength={2}
          error={error?.field("country")}
        />
        <FormError error={error} />
        <Button title="Save" busy={busy} onPress={() => void save(form)} />
      </Padded>
    </Section>
  )
}

const AVAILABILITY = [
  { value: "open", label: "Open" },
  { value: "limited", label: "Limited" },
  { value: "closed", label: "Closed" },
] as const
const DEALS = [
  { value: "split", label: "Revenue split" },
  { value: "fixed", label: "Fixed fee" },
  { value: "either", label: "Either" },
] as const

function BuilderForm({
  initial,
  onSaved,
}: {
  initial: NonNullable<ProfileResponse["builder"]>
  onSaved: () => void
}) {
  const theme = useTheme()
  const [form, setForm] = useState({
    ...initial,
    skills: initial.skills.join(", "),
    stack: initial.stack.join(", "),
  })
  const { busy, error, save } = useSave("/profile/builder", onSaved)
  return (
    <Section
      title="Builder profile"
      footer="Shown on your public page /b/handle and used for matching."
    >
      <Padded style={styles.form}>
        <Field
          label="Display name"
          value={form.displayName}
          onChangeText={(displayName) => setForm({ ...form, displayName })}
          error={error?.field("displayName")}
        />
        <Field
          label="Handle"
          value={form.handle}
          onChangeText={(handle) => setForm({ ...form, handle })}
          autoCapitalize="none"
          autoCorrect={false}
          error={error?.field("handle")}
        />
        <Field
          label="Bio"
          value={form.bio}
          onChangeText={(bio) => setForm({ ...form, bio })}
          multiline
          error={error?.field("bio")}
        />
        <Field
          label="Skills"
          hint="Comma separated, up to 12."
          value={form.skills}
          onChangeText={(skills) => setForm({ ...form, skills })}
          error={error?.field("skills")}
        />
        <Field
          label="Stack"
          hint="Comma separated, up to 12."
          value={form.stack}
          onChangeText={(stack) => setForm({ ...form, stack })}
          error={error?.field("stack")}
        />
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.secondaryLabel, fontSize: 13, marginLeft: 4 }}>
            Availability
          </Text>
          <Segmented
            options={AVAILABILITY}
            value={form.availability}
            onChange={(availability) => setForm({ ...form, availability })}
          />
        </View>
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.secondaryLabel, fontSize: 13, marginLeft: 4 }}>
            How you like to be paid
          </Text>
          <Segmented
            options={DEALS}
            value={form.dealPreference}
            onChange={(dealPreference) => setForm({ ...form, dealPreference })}
          />
        </View>
        <FormError error={error} />
        <Button title="Save" busy={busy} onPress={() => void save(form)} />
      </Padded>
    </Section>
  )
}

const styles = StyleSheet.create({
  form: { gap: SPACING.lg },
})
