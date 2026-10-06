import {
  appStoreSyncOutput,
  appStoreVerifyOutput,
  importStatusOutput,
  okSchema,
  webImportOutput,
} from "@shared/schemas"
import { Image } from "expo-image"
import { router, Stack } from "expo-router"
import * as WebBrowser from "expo-web-browser"
import { useState } from "react"
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native"

import { gradientStyle } from "@/components/listing"
import { api, ApiError, errorMessage } from "@/lib/api"
import { formatRelative } from "@/lib/format"
import { notifyError, notifySuccess } from "@/lib/haptics"
import { useApi } from "@/lib/use-api"
import { Button, Field, Loaded, Padded, Screen, Section } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * Builders: import listings (CLAUDE.md §19.45). Paste an App Store developer link (or an app
 * link, or the id) and every app becomes a listing; paste a product's web address and its page
 * becomes one. Verification: the code goes into any app description, then "Check".
 */
export default function ImportsScreen() {
  const theme = useTheme()
  const state = useApi(() => api(importStatusOutput, "GET", "/listings/import"))
  const [appStoreValue, setAppStoreValue] = useState("")
  const [appStoreError, setAppStoreError] = useState<string | null>(null)
  const [urlValue, setUrlValue] = useState("")
  const [urlError, setUrlError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function run(name: string, work: () => Promise<string>) {
    setBusy(name)
    try {
      const message = await work()
      notifySuccess()
      Alert.alert("Done", message)
      await state.reload()
    } catch (error) {
      notifyError()
      if (error instanceof ApiError && (error.field("appStore") || error.field("url"))) {
        setAppStoreError(error.field("appStore") ?? null)
        setUrlError(error.field("url") ?? null)
      } else {
        Alert.alert("That didn't work", errorMessage(error))
      }
    } finally {
      setBusy(null)
    }
  }

  const summary = (result: {
    developerName: string
    created: number
    updated: number
    removed: number
  }) =>
    `${result.developerName}: ${result.created} new, ${result.updated} updated${result.removed ? `, ${result.removed} no longer in the store` : ""}.`

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Stack.Screen options={{ title: "Import listings" }} />
      <Loaded state={state}>
        {(data) => (
          <>
            <Section
              title="App Store"
              footer={
                data.appStore
                  ? "New apps are added on their own every day."
                  : "Paste your developer link and every app you've published becomes a listing."
              }
            >
              <Padded style={{ gap: SPACING.md, paddingVertical: SPACING.md }}>
                {data.appStore ? (
                  <>
                    <Pressable
                      onPress={() => void WebBrowser.openBrowserAsync(data.appStore!.developerUrl)}
                    >
                      <Text style={{ color: theme.label, fontSize: 17, fontWeight: "600" }}>
                        {data.appStore.developerName ?? "Your developer account"}
                      </Text>
                      <Text
                        style={{
                          color: data.appStore.verified ? theme.success : theme.warning,
                          marginTop: 2,
                        }}
                      >
                        {data.appStore.verified ? "Verified" : "Unverified"}
                        <Text style={{ color: theme.secondaryLabel }}>
                          {data.appStore.syncedAt
                            ? ` · updated ${formatRelative(data.appStore.syncedAt)}`
                            : ""}
                        </Text>
                      </Text>
                    </Pressable>
                    {!data.appStore.verified && data.appStore.verificationCode ? (
                      <View style={[styles.codeBox, { backgroundColor: theme.fill }]}>
                        <Text style={{ color: theme.secondaryLabel }}>
                          Prove it&apos;s yours: add this code to one app&apos;s description in App
                          Store Connect, then check.
                        </Text>
                        <Text selectable style={[styles.code, { color: theme.label }]}>
                          {data.appStore.verificationCode}
                        </Text>
                        <View style={styles.row}>
                          <Button
                            title="Share code"
                            kind="plain"
                            onPress={() =>
                              void Share.share({ message: data.appStore?.verificationCode ?? "" })
                            }
                          />
                          <Button
                            title="Check now"
                            kind="tinted"
                            busy={busy === "verify"}
                            onPress={() =>
                              void run("verify", async () => {
                                await api(
                                  appStoreVerifyOutput,
                                  "POST",
                                  "/listings/app-store/verify",
                                )
                                return "Verified. Creators now see your apps as yours."
                              })
                            }
                          />
                        </View>
                      </View>
                    ) : null}
                    <Button
                      title="Refresh"
                      kind="tinted"
                      icon="arrow.clockwise"
                      busy={busy === "refresh"}
                      onPress={() =>
                        void run("refresh", async () =>
                          summary(
                            await api(appStoreSyncOutput, "POST", "/listings/app-store/refresh"),
                          ),
                        )
                      }
                    />
                    <Button
                      title="Use another account"
                      kind="plain"
                      onPress={() =>
                        void run("disconnect", async () => {
                          await api(okSchema, "DELETE", "/listings/app-store")
                          return "Disconnected. Your listings stay until you archive them."
                        })
                      }
                    />
                  </>
                ) : (
                  <>
                    <Field
                      label="Developer link or id"
                      value={appStoreValue}
                      onChangeText={(text) => {
                        setAppStoreValue(text)
                        setAppStoreError(null)
                      }}
                      placeholder="apps.apple.com/us/developer/…/id123456789"
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      error={appStoreError}
                      hint="An app link works too: we'll find its developer."
                    />
                    <Button
                      title="Import my apps"
                      busy={busy === "appstore"}
                      disabled={appStoreValue.trim() === ""}
                      onPress={() =>
                        void run("appstore", async () => {
                          const result = await api(
                            appStoreSyncOutput,
                            "POST",
                            "/listings/app-store",
                            {
                              appStore: appStoreValue,
                            },
                          )
                          setAppStoreValue("")
                          return summary(result)
                        })
                      }
                    />
                  </>
                )}
              </Padded>
            </Section>

            <Section title="From a link" footer="A web app, template or tool: we read its page.">
              <Padded style={{ gap: SPACING.md, paddingVertical: SPACING.md }}>
                <Field
                  label="Product page"
                  value={urlValue}
                  onChangeText={(text) => {
                    setUrlValue(text)
                    setUrlError(null)
                  }}
                  placeholder="https://yourproduct.com"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  error={urlError}
                />
                <Button
                  title="Import"
                  busy={busy === "web"}
                  disabled={urlValue.trim() === ""}
                  onPress={() =>
                    void run("web", async () => {
                      const result = await api(webImportOutput, "POST", "/listings/web", {
                        url: urlValue,
                      })
                      setUrlValue("")
                      return result.action === "created"
                        ? `Listed “${result.title}”.`
                        : `“${result.title}” is up to date.`
                    })
                  }
                />
              </Padded>
            </Section>

            {data.listings.length > 0 ? (
              <Section title={`Imported (${data.listings.length})`}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ padding: SPACING.md, gap: SPACING.md }}
                >
                  {data.listings.map((listing) => (
                    <Pressable
                      key={listing.id}
                      accessibilityRole="button"
                      accessibilityLabel={listing.title}
                      onPress={() => router.push(`/product/${listing.id}`)}
                      style={{ width: 96, gap: 6 }}
                    >
                      <View
                        style={[
                          styles.thumb,
                          gradientStyle({
                            from: "#5856D6",
                            to: "#AF52DE",
                            angle: 135,
                            initials: listing.initials,
                            gradient: listing.gradient,
                          }),
                        ]}
                      >
                        {listing.coverUrl ? (
                          <Image
                            source={listing.coverUrl}
                            style={StyleSheet.absoluteFill}
                            contentFit="cover"
                            contentPosition="top"
                          />
                        ) : listing.iconUrl ? (
                          <Image source={listing.iconUrl} style={styles.thumbIcon} />
                        ) : (
                          <Text style={styles.thumbInitials}>{listing.initials}</Text>
                        )}
                      </View>
                      <Text numberOfLines={2} style={{ color: theme.label, fontSize: 12 }}>
                        {listing.title}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </Section>
            ) : null}
          </>
        )}
      </Loaded>
    </Screen>
  )
}

const styles = StyleSheet.create({
  codeBox: { gap: SPACING.sm, padding: SPACING.md, borderRadius: 14 },
  code: { fontSize: 22, fontWeight: "600", letterSpacing: 2, fontVariant: ["tabular-nums"] },
  row: { flexDirection: "row", gap: SPACING.sm },
  thumb: {
    width: 96,
    height: 128,
    borderRadius: 18,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbIcon: { width: 52, height: 52, borderRadius: 12 },
  thumbInitials: { color: "#FFFFFF", fontSize: 24, fontWeight: "600" },
})
