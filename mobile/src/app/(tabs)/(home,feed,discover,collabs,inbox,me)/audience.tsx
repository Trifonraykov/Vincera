import { audienceOutput } from "@shared/schemas"
import { StyleSheet, Text, View } from "react-native"

import { api } from "@/lib/api"
import { formatCount, formatRelative, SIZE_TIER_LABELS } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { Body, Loaded, Message, Padded, Pill, Row, Screen, Section } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/** Audience (§12 `/app/audience`, creators): size tier, AI summary and each platform's numbers. */
export default function AudienceScreen() {
  const theme = useTheme()
  const state = useApi(() => api(audienceOutput, "GET", "/audience"))
  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Loaded state={state}>
        {(audience) =>
          !audience.isCreator ? (
            <Message
              icon="chart.bar"
              title="For creators"
              body="Add the creator role on the web to connect your channels."
            />
          ) : (
            <>
              <Padded>
                <View style={styles.tier}>
                  <Text style={[styles.tierText, { color: theme.label }]}>
                    {audience.tier.tier ? SIZE_TIER_LABELS[audience.tier.tier] : "No size tier yet"}
                  </Text>
                  <Pill
                    label={audience.tier.verified ? "Verified" : "Unverified"}
                    tone={audience.tier.verified ? "success" : "warning"}
                  />
                </View>
                {audience.lastSyncedAt ? (
                  <Text style={{ color: theme.secondaryLabel }}>
                    Updated {formatRelative(audience.lastSyncedAt)}
                  </Text>
                ) : null}
              </Padded>

              {audience.profile?.audienceSummary ? (
                <Section
                  title="Your audience"
                  footer={
                    audience.summaryPending
                      ? "A new summary is being written."
                      : "Written by AI from your numbers; edit it on the web."
                  }
                >
                  <Padded>
                    <Body>{audience.profile.audienceSummary}</Body>
                    {audience.profile.topics.length > 0 ? (
                      <Text style={{ color: theme.secondaryLabel }}>
                        {audience.profile.topics.map((topic) => `#${topic}`).join("  ")}
                      </Text>
                    ) : null}
                  </Padded>
                </Section>
              ) : null}

              {audience.connections.length === 0 ? (
                <Message
                  icon="link"
                  title="No channels connected"
                  body="Connect YouTube, Instagram or TikTok in Settings → Connections on the web."
                />
              ) : (
                audience.connections.map((connection) => (
                  <Section
                    key={connection.id}
                    title={`${connection.label}${connection.username ? ` · @${connection.username}` : ""}`}
                    footer={
                      connection.health === "ok"
                        ? connection.latest
                          ? `Synced ${formatRelative(connection.latest.takenAt)}`
                          : undefined
                        : connection.health === "syncing"
                          ? "Syncing…"
                          : connection.health === "expired"
                            ? "Access expired: reconnect on the web."
                            : connection.health === "unverified"
                              ? "Entered by hand, not verified yet."
                              : "The last sync failed; showing the previous numbers."
                    }
                  >
                    <Row title="Followers" detail={formatCount(connection.latest?.followers)} />
                    <Row title="Average views" detail={formatCount(connection.latest?.avgViews)} />
                    <Row
                      title="Engagement"
                      detail={
                        connection.latest?.engagementRate === null ||
                        connection.latest?.engagementRate === undefined
                          ? "–"
                          : `${(connection.latest.engagementRate * 100).toFixed(1)}%`
                      }
                      last={(connection.latest?.topCountries.length ?? 0) === 0}
                    />
                    {connection.latest && connection.latest.topCountries.length > 0 ? (
                      <Padded>
                        <Text style={{ color: theme.secondaryLabel, fontSize: 13 }}>
                          Top countries (
                          {connection.latest.countriesBasis === "followers"
                            ? "followers"
                            : "viewers"}
                          )
                        </Text>
                        {connection.latest.topCountries.slice(0, 5).map((country) => (
                          <View key={country.country} style={styles.bar}>
                            <Text style={[styles.country, { color: theme.label }]}>
                              {country.country}
                            </Text>
                            <View style={[styles.track, { backgroundColor: theme.fill }]}>
                              <View
                                style={[
                                  styles.fill,
                                  {
                                    width: `${Math.round(country.share * 100)}%`,
                                    backgroundColor: theme.tint,
                                  },
                                ]}
                              />
                            </View>
                            <Text style={[styles.share, { color: theme.secondaryLabel }]}>
                              {Math.round(country.share * 100)}%
                            </Text>
                          </View>
                        ))}
                      </Padded>
                    ) : null}
                  </Section>
                ))
              )}
            </>
          )
        }
      </Loaded>
    </Screen>
  )
}

const styles = StyleSheet.create({
  tier: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, flexWrap: "wrap" },
  tierText: { fontSize: 22, fontWeight: "600" },
  bar: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  country: { width: 32, fontSize: 15, fontWeight: "600" },
  track: { flex: 1, height: 8, borderRadius: 4, overflow: "hidden" },
  fill: { height: 8 },
  share: { width: 40, textAlign: "right", fontVariant: ["tabular-nums"] },
})
