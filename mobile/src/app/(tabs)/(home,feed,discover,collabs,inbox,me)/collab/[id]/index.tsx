import { collabDetailSchema } from "@shared/schemas"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { StyleSheet, Text, View } from "react-native"

import { api } from "@/lib/api"
import { COLLAB_STAGE_LABELS } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { Body, Loaded, Padded, Pill, Row, Screen, Section } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/** A collab's overview (§12 `/app/collabs/[id]`): stage, members and splits, next step, scope. */
const STAGES = ["agreement", "building", "launch_review", "live"] as const

export default function CollabScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const theme = useTheme()
  const state = useApi(() => api(collabDetailSchema, "GET", `/collabs/${id}`), id)
  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Stack.Screen
        options={{ title: state.data?.target.title ?? "Collab", headerLargeTitleEnabled: false }}
      />
      <Loaded state={state}>
        {(collab) => {
          const stageIndex = STAGES.indexOf(collab.stage as (typeof STAGES)[number])
          return (
            <>
              <Padded>
                <Text style={[styles.title, { color: theme.label }]}>{collab.target.title}</Text>
                <View
                  style={styles.track}
                  accessibilityLabel={`Stage: ${COLLAB_STAGE_LABELS[collab.stage]}`}
                >
                  {STAGES.map((stage, index) => (
                    <View key={stage} style={styles.step}>
                      <View
                        style={[
                          styles.dot,
                          { backgroundColor: index <= stageIndex ? theme.tint : theme.fill },
                        ]}
                      />
                      <Text
                        style={[
                          styles.stepText,
                          { color: index === stageIndex ? theme.label : theme.secondaryLabel },
                        ]}
                      >
                        {COLLAB_STAGE_LABELS[stage]}
                      </Text>
                    </View>
                  ))}
                </View>
                {collab.stage === "ended" ? <Pill label="Ended" /> : null}
              </Padded>

              <Section title="Next step">
                <Row
                  icon={collab.nextStep.needsViewer ? "signature" : "arrow.right.circle"}
                  title={collab.nextStep.text}
                  onPress={
                    collab.stage === "agreement"
                      ? () => router.push(`/collab/${collab.id}/agreement`)
                      : () => router.push(`/collab/${collab.id}/tasks`)
                  }
                  last
                />
              </Section>

              <Section title="Members">
                {collab.members.map((member, index) => (
                  <Row
                    key={member.userId}
                    icon={member.role === "creator" ? "person.wave.2" : "hammer"}
                    title={member.name}
                    subtitle={`${member.role === "creator" ? "Creator" : "Builder"}${member.payoutsReady ? "" : " · payouts not set up"}`}
                    detail={`${member.splitPct}%`}
                    last={index === collab.members.length - 1}
                  />
                ))}
              </Section>

              <Section>
                <Row
                  icon="doc.text"
                  title="Agreement"
                  detail={
                    collab.agreement?.status === "signed"
                      ? "Signed"
                      : collab.agreement
                        ? "To sign"
                        : undefined
                  }
                  onPress={() => router.push(`/collab/${collab.id}/agreement`)}
                />
                <Row
                  icon="checklist"
                  title="Tasks"
                  detail={collab.openTasks > 0 ? `${collab.openTasks} open` : undefined}
                  onPress={() => router.push(`/collab/${collab.id}/tasks`)}
                />
                {collab.threadId ? (
                  <Row
                    icon="bubble.left.and.bubble.right"
                    title="Messages"
                    onPress={() => router.push(`/thread/${collab.threadId}`)}
                    last
                  />
                ) : null}
              </Section>

              {collab.scope ? (
                <Section
                  title="Scope"
                  footer={
                    collab.timelineWeeks
                      ? `Aim: ready to launch within ${collab.timelineWeeks} weeks.`
                      : undefined
                  }
                >
                  <Padded>
                    <Body>{collab.scope}</Body>
                  </Padded>
                </Section>
              ) : null}
            </>
          )
        }}
      </Loaded>
    </Screen>
  )
}

const styles = StyleSheet.create({
  title: { fontSize: 28, fontWeight: "700" },
  track: { flexDirection: "row", marginTop: SPACING.md, gap: SPACING.xs },
  step: { flex: 1, gap: 6 },
  dot: { height: 4, borderRadius: 2 },
  stepText: { fontSize: 12 },
})
