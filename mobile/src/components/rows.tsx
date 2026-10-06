import type { CollabListItem, Match, ProposalListItem } from "@shared/schemas"
import { router } from "expo-router"
import { StyleSheet, Text, View } from "react-native"

import { COLLAB_STAGE_LABELS, formatTimeLeft, scoreLabel, STATUS_LABELS } from "@/lib/format"
import { Row } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/** Rows shared by Home and the list screens. */

export function ProposalRow({ item, last }: { item: ProposalListItem; last?: boolean }) {
  const status = item.yourTurn
    ? `Your turn · expires ${formatTimeLeft(item.expiresAt)}`
    : (STATUS_LABELS[item.status] ?? item.status)
  return (
    <Row
      icon={item.yourTurn ? "exclamationmark.bubble.fill" : "paperplane"}
      title={item.target.title}
      subtitle={`${item.counterpart.name} · ${item.creatorSplitPct}/${item.builderSplitPct} · ${item.timelineWeeks} wk\n${status}`}
      onPress={() => router.push(`/proposal/${item.id}`)}
      last={last}
    />
  )
}

export function CollabRow({ item, last }: { item: CollabListItem; last?: boolean }) {
  return (
    <Row
      icon={item.nextStep.needsViewer ? "signature" : "person.2"}
      title={item.title}
      subtitle={`With ${item.partners.map((partner) => partner.name).join(", ")} · ${
        COLLAB_STAGE_LABELS[item.stage] ?? item.stage
      }\n${item.nextStep.needsViewer ? "Your turn: " : ""}${item.nextStep.text}`}
      onPress={() => router.push(`/collab/${item.id}`)}
      last={last}
    />
  )
}

/** Where a match's card leads: native screens for ideas and products. */
export function matchTitle(match: Match): string {
  const target = match.target
  switch (target.type) {
    case "idea":
    case "product":
      return target.title
    case "builder":
    case "creator":
      return `${target.name} (@${target.handle})`
  }
}

export function matchSubtitle(match: Match): string {
  const target = match.target
  switch (target.type) {
    case "idea":
      return `Idea by ${target.ownerName}`
    case "product":
      return `Product by ${target.ownerName}`
    case "builder":
      return `Builder · ${[...target.skills, ...target.stack].slice(0, 4).join(", ")}`
    case "creator":
      return `Creator${target.niche ? ` · ${target.niche}` : ""}`
  }
}

export function ScoreLine({ score }: { score: number }) {
  const theme = useTheme()
  return (
    <View style={styles.score}>
      <View style={[styles.track, { backgroundColor: theme.fill }]}>
        <View
          style={[
            styles.fill,
            {
              width: `${Math.round(score * 100)}%`,
              backgroundColor:
                score >= 0.7 ? theme.success : score >= 0.5 ? theme.tint : theme.warning,
            },
          ]}
        />
      </View>
      <Text style={[styles.scoreText, { color: theme.secondaryLabel }]}>{scoreLabel(score)}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  score: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  track: { flex: 1, height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
  scoreText: { fontSize: 13, fontVariant: ["tabular-nums"] },
})
