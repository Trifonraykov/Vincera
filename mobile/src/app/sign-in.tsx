import * as WebBrowser from "expo-web-browser"
import { useState } from "react"
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"

import { ApiError, errorMessage } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { DEV_MAILBOX_URL } from "@/lib/config"
import { notifyError, notifySuccess } from "@/lib/haptics"
import { Button, Field, Screen } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * Sign in or sign up with the 8-character code from the email (CLAUDE.md §19.19): no password, no
 * web view. The same email also carries a link for the web.
 */
export default function SignInScreen() {
  const auth = useAuth()
  const theme = useTheme()
  const [step, setStep] = useState<"email" | "code">("email")
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field?: "email" | "code"; message: string } | null>(null)

  async function sendCode() {
    setBusy(true)
    setError(null)
    try {
      await auth.requestCode(email.trim())
      notifySuccess()
      setStep("code")
    } catch (caught) {
      notifyError()
      setError({
        field: caught instanceof ApiError && caught.field("email") ? "email" : undefined,
        message:
          caught instanceof ApiError
            ? (caught.field("email") ?? caught.message)
            : errorMessage(caught),
      })
    } finally {
      setBusy(false)
    }
  }

  async function verify() {
    setBusy(true)
    setError(null)
    try {
      await auth.verifyCode(email.trim(), code)
      notifySuccess()
    } catch (caught) {
      notifyError()
      setError({ field: "code", message: errorMessage(caught) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.safe}
      >
        <Screen>
          <View style={styles.hero}>
            <View style={[styles.logo, { backgroundColor: "#0a0a0a" }]}>
              {/* The logo mark (lib/pwa/icons.ts): two overlapping rounded squares. */}
              <View style={styles.mark}>
                <View style={[styles.square, styles.front]} />
                <View style={[styles.square, styles.back]} />
              </View>
            </View>
            <Text style={[styles.title, { color: theme.label }]}>Vincera</Text>
            <Text style={[styles.subtitle, { color: theme.secondaryLabel }]}>
              Creators and builders make small products together.
            </Text>
          </View>

          <View style={styles.form}>
            {step === "email" ? (
              <>
                <Field
                  label="Email"
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  returnKeyType="send"
                  onSubmitEditing={() => void sendCode()}
                  error={error?.field === "email" ? error.message : null}
                  hint="We'll email you a sign-in code. New here? The same code creates your account."
                />
                {error && error.field !== "email" ? (
                  <Text
                    accessibilityLiveRegion="polite"
                    style={[styles.error, { color: theme.destructive }]}
                  >
                    {error.message}
                  </Text>
                ) : null}
                <Button
                  title="Email me a code"
                  busy={busy}
                  disabled={!email.includes("@")}
                  onPress={() => void sendCode()}
                />
              </>
            ) : (
              <>
                <Text style={[styles.sent, { color: theme.label }]}>
                  We sent a code to <Text style={styles.bold}>{email.trim()}</Text>. It works once
                  and expires in 24 hours.
                </Text>
                <Field
                  label="Sign-in code"
                  value={code}
                  onChangeText={(value) => setCode(value.toUpperCase())}
                  placeholder="ABCD-EFGH"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  maxLength={9}
                  returnKeyType="go"
                  onSubmitEditing={() => void verify()}
                  error={error?.message}
                  style={styles.code}
                />
                <Button
                  title="Sign in"
                  busy={busy}
                  disabled={code.replace(/[^A-Za-z0-9]/g, "").length < 8}
                  onPress={() => void verify()}
                />
                <Button
                  title="Use a different email"
                  kind="plain"
                  onPress={() => {
                    setStep("email")
                    setCode("")
                    setError(null)
                  }}
                />
                {__DEV__ ? (
                  <Button
                    title="Open the dev mailbox"
                    kind="tinted"
                    icon="envelope"
                    onPress={() => void WebBrowser.openBrowserAsync(DEV_MAILBOX_URL)}
                  />
                ) : null}
              </>
            )}
          </View>
        </Screen>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  hero: {
    alignItems: "center",
    gap: SPACING.sm,
    paddingTop: SPACING.xl * 2,
    paddingHorizontal: SPACING.xl,
  },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: SPACING.sm,
  },
  mark: { width: 48, height: 48 },
  square: { position: "absolute", width: 26, height: 26, borderRadius: 7 },
  front: { left: 4, top: 4, backgroundColor: "#fafafa" },
  back: { left: 18, top: 18, backgroundColor: "#404040", borderWidth: 3, borderColor: "#fafafa" },
  title: { fontSize: 34, fontWeight: "700" },
  subtitle: { fontSize: 17, textAlign: "center", lineHeight: 22 },
  form: { padding: SPACING.lg, gap: SPACING.lg, marginTop: SPACING.xl },
  error: { fontSize: 15 },
  sent: { fontSize: 17, lineHeight: 23 },
  bold: { fontWeight: "600" },
  code: { fontSize: 28, letterSpacing: 4, textAlign: "center", fontVariant: ["tabular-nums"] },
})
