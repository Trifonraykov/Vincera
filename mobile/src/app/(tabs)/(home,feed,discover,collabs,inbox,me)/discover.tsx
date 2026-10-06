import {
  discoverOutput,
  markShownOutput,
  matchActionOutput,
  matchClickOutput,
  type DiscoverView,
  type Match,
  type MatchTarget,
} from "@shared/schemas"
import { router } from "expo-router"
import * as WebBrowser from "expo-web-browser"
import { useEffect, useState } from "react"
import { Alert, Pressable, StyleSheet, Text, View } from "react-native"

import { matchSubtitle, matchTitle, ScoreLine } from "@/components/rows"
import { api, errorMessage } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { FEATURE_LABELS } from "@/lib/format"
import { notifySuccess, selectionTick } from "@/lib/haptics"
import { useApi } from "@/lib/use-api"
import { Button, Icon, Loaded, Message, Screen, Section, Segmented } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * Discover (§12 `/app/discover/*`): ranked matches with the plain-language explanation (§8),
 * "Why this match" with the seven features, Save, Dismiss and Propose. Briefs lists open ideas for
 * builders. Shown, saved, dismissed and opened cards write the same events as the web.
 */

const VIEWS: Record<"creator" | "builder", { value: DiscoverView; label: string }[]> = {
  creator: [
    { value: "for_you", label: "For you" },
    { value: "builders", label: "Builders" },
    { value: "saved", label: "Saved" },
  ],
  builder: [
    { value: "for_you", label: "For you" },
    { value: "briefs", label: "Briefs" },
    { value: "creators", label: "Creators" },
    { value: "saved", label: "Saved" },
  ],
}

function proposeHref(target: MatchTarget, matchId: string | null) {
  const params = new URLSearchParams({ to: target.ownerUserId })
  if (target.type === "idea" || target.type === "product") {
    params.set("kind", target.type)
    params.set("targetId", target.id)
    params.set("title", target.title)
  }
  if (matchId) params.set("matchId", matchId)
  return `/propose?${params.toString()}` as const
}

export default function DiscoverScreen() {
  const me = useMe()
  const role = me.activeRole === "builder" ? "builder" : "creator"
  const [view, setView] = useState<DiscoverView>("for_you")
  const state = useApi(() => api(discoverOutput, "GET", `/discover?view=${view}`), view)

  // `match.shown` once the cards are on screen (the server records each row once).
  const shownIds = state.data?.matches.map((match) => match.id).join(",") ?? ""
  useEffect(() => {
    const items =
      state.data?.matches.map((match, index) => ({ matchId: match.id, rank: index + 1 })) ?? []
    if (items.length > 0)
      void api(markShownOutput, "POST", "/discover/shown", { items }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownIds])

  async function act(match: Match, rank: number, action: "save" | "unsave" | "dismiss") {
    try {
      const result = await api(
        matchActionOutput,
        "POST",
        `/discover/matches/${match.id}/${action}`,
        { rank },
      )
      selectionTick()
      state.setData((current) =>
        current
          ? {
              ...current,
              matches:
                result.status === "dismissed" || (view === "saved" && action === "unsave")
                  ? current.matches.filter((item) => item.id !== match.id)
                  : current.matches.map((item) =>
                      item.id === match.id ? { ...item, status: result.status } : item,
                    ),
            }
          : current,
      )
    } catch (error) {
      Alert.alert("Couldn't update the match", errorMessage(error))
    }
  }

  async function open(match: Match, rank: number) {
    try {
      const result = await api(matchClickOutput, "POST", `/discover/matches/${match.id}/click`, {
        rank,
      })
      if (result.target.type === "idea") router.push(`/idea/${result.target.id}`)
      else if (result.target.type === "product") router.push(`/product/${result.target.id}`)
      else await WebBrowser.openBrowserAsync(result.webUrl)
    } catch (error) {
      Alert.alert("Couldn't open it", errorMessage(error))
    }
  }

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Segmented options={VIEWS[role]} value={view} onChange={setView} />
      <Loaded state={state}>
        {(data) =>
          !data.hasProfile ? (
            <Message
              icon="person.crop.circle"
              title="Set up your profile first"
              body="Matches use your profile. Finish it on the web."
            />
          ) : data.matches.length === 0 && (data.otherBriefs?.length ?? 0) === 0 ? (
            <Message
              icon="safari"
              title={view === "saved" ? "Nothing saved yet" : "No matches here right now"}
              body={
                view === "saved"
                  ? "Save a match to keep it here."
                  : "New people and listings arrive every day."
              }
            />
          ) : (
            <>
              {data.matches.map((match, index) => (
                <MatchCard
                  key={match.id}
                  match={match}
                  onOpen={() => void open(match, index + 1)}
                  onSave={() =>
                    void act(match, index + 1, match.status === "saved" ? "unsave" : "save")
                  }
                  onDismiss={() => void act(match, index + 1, "dismiss")}
                  onPropose={() => router.push(proposeHref(match.target, match.id))}
                />
              ))}
              {data.otherBriefs && data.otherBriefs.length > 0 ? (
                <Section title="More open briefs">
                  {data.otherBriefs.map((brief, index) =>
                    brief.type === "idea" ? (
                      <BriefRow
                        key={brief.id}
                        title={brief.title}
                        owner={brief.ownerName}
                        last={index === (data.otherBriefs?.length ?? 0) - 1}
                        onPress={() => router.push(`/idea/${brief.id}`)}
                      />
                    ) : null,
                  )}
                </Section>
              ) : null}
            </>
          )
        }
      </Loaded>
    </Screen>
  )
}

function BriefRow({
  title,
  owner,
  onPress,
  last,
}: {
  title: string
  owner: string
  onPress: () => void
  last: boolean
}) {
  const theme = useTheme()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={[
        styles.brief,
        !last && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.separator,
        },
      ]}
    >
      <Text style={[styles.title, { color: theme.label }]}>{title}</Text>
      <Text style={{ color: theme.secondaryLabel }}>Idea by {owner}</Text>
    </Pressable>
  )
}

function MatchCard({
  match,
  onOpen,
  onSave,
  onDismiss,
  onPropose,
}: {
  match: Match
  onOpen: () => void
  onSave: () => void
  onDismiss: () => void
  onPropose: () => void
}) {
  const theme = useTheme()
  const [why, setWhy] = useState(false)
  const saved = match.status === "saved"
  const topics = "topics" in match.target ? match.target.topics : []
  return (
    <View style={[styles.card, { backgroundColor: theme.card }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${matchTitle(match)}`}
        onPress={onOpen}
        style={styles.cardHead}
      >
        <Text style={[styles.kicker, { color: theme.secondaryLabel }]}>{matchSubtitle(match)}</Text>
        <Text style={[styles.title, { color: theme.label }]}>{matchTitle(match)}</Text>
      </Pressable>
      <ScoreLine score={match.score} />
      <Text style={[styles.explanation, { color: theme.label }]}>{match.explanation}</Text>
      {topics.length > 0 ? (
        <Text style={{ color: theme.secondaryLabel }}>
          {topics.map((topic) => `#${topic}`).join("  ")}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: why }}
        onPress={() => setWhy(!why)}
        style={styles.why}
      >
        <Icon name={why ? "chevron.down" : "chevron.right"} size={12} />
        <Text style={{ color: theme.tint, fontSize: 15 }}>Why this match</Text>
      </Pressable>
      {why ? (
        <View style={styles.features}>
          {Object.entries(match.features).map(([name, value]) => (
            <View key={name} style={styles.feature}>
              <Text style={[styles.featureName, { color: theme.secondaryLabel }]}>
                {FEATURE_LABELS[name] ?? name}
              </Text>
              <View style={[styles.track, { backgroundColor: theme.fill }]}>
                <View
                  style={[
                    styles.bar,
                    { width: `${Math.round(value * 100)}%`, backgroundColor: theme.tint },
                  ]}
                />
              </View>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.actions}>
        <View style={styles.action}>
          <Button
            title={saved ? "Saved" : "Save"}
            kind="tinted"
            icon={saved ? "bookmark.fill" : "bookmark"}
            onPress={onSave}
          />
        </View>
        <View style={styles.action}>
          <Button title="Dismiss" kind="plain" icon="xmark" onPress={onDismiss} />
        </View>
      </View>
      {match.target.available && match.status !== "proposed" ? (
        <Button
          title="Send a proposal"
          icon="paperplane.fill"
          onPress={() => {
            notifySuccess()
            onPropose()
          }}
        />
      ) : match.status === "proposed" ? (
        <Text style={{ color: theme.secondaryLabel }}>You sent a proposal from this match.</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.lg,
    borderRadius: 14,
    padding: SPACING.lg,
    gap: SPACING.md,
  },
  cardHead: { gap: 2 },
  kicker: { fontSize: 13, textTransform: "uppercase" },
  title: { fontSize: 20, fontWeight: "600" },
  explanation: { fontSize: 16, lineHeight: 22 },
  why: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 },
  features: { gap: 6 },
  feature: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  featureName: { width: 110, fontSize: 13 },
  track: { flex: 1, height: 6, borderRadius: 3, overflow: "hidden" },
  bar: { height: 6 },
  actions: { flexDirection: "row", gap: SPACING.sm },
  action: { flex: 1 },
  brief: { padding: SPACING.lg, gap: 2 },
})
