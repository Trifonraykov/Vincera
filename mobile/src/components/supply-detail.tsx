import { supplySavedOutput, type IdeaDetail, type ProductDetail } from "@shared/schemas"
import { router, Stack } from "expo-router"
import { Alert, StyleSheet, Text, View } from "react-native"

import { api, errorMessage } from "@/lib/api"
import { FORMAT_LABELS, formatDate, formatMoney, STAGE_LABELS, STATUS_LABELS } from "@/lib/format"
import { notifySuccess } from "@/lib/haptics"
import { Body, Button, Padded, Pill, Row, Section } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/** An idea or a product: what it is, its facts, and what the viewer may do with it. */

type Props =
  | { kind: "idea"; item: IdeaDetail; onChanged: () => void }
  | { kind: "product"; item: ProductDetail; onChanged: () => void }

export function SupplyDetail(props: Props) {
  const { kind, item, onChanged } = props
  const theme = useTheme()
  const path = kind === "idea" ? "/ideas" : "/products"

  async function change(action: "publish" | "archive" | "restore") {
    try {
      await api(supplySavedOutput, "POST", `${path}/${item.id}/status`, { action })
      notifySuccess()
      onChanged()
    } catch (error) {
      Alert.alert("Couldn't change it", errorMessage(error))
    }
  }

  const facts: [string, string][] = [
    ["Status", STATUS_LABELS[item.status] ?? item.status],
    ["Format", FORMAT_LABELS[item.format] ?? item.format],
    ["Target price", formatMoney(item.targetPriceCents, item.currency)],
  ]
  if (props.kind === "product") {
    facts.push(["Stage", STAGE_LABELS[props.item.stage] ?? props.item.stage])
    if (props.item.preferredSplitBuilderPct !== null) {
      facts.push(["Builder's preferred share", `${props.item.preferredSplitBuilderPct}%`])
    }
    facts.push(["Exclusive", props.item.exclusivity ? "Yes" : "No"])
  }
  if (item.publishedAt) facts.push(["Published", formatDate(item.publishedAt)])

  const text =
    props.kind === "idea"
      ? [
          ["The problem", props.item.problem],
          ["Audience evidence", props.item.audienceEvidence],
        ]
      : [
          ["Description", props.item.description],
          ["Who it's for", props.item.targetUser],
        ]

  return (
    <>
      <Stack.Screen
        options={{
          title: item.title,
          headerLargeTitleEnabled: false,
          headerRight: item.ownerActions.includes("edit")
            ? () => (
                <Text
                  accessibilityRole="button"
                  onPress={() => router.push(`/supply-editor?kind=${kind}&id=${item.id}`)}
                  style={{ color: theme.tint, fontSize: 17 }}
                >
                  Edit
                </Text>
              )
            : undefined,
        }}
      />
      <Padded>
        <Text style={[styles.title, { color: theme.label }]}>{item.title}</Text>
        <Text style={{ color: theme.secondaryLabel, fontSize: 15 }}>
          {kind === "idea" ? "Idea" : "Product"} by {item.owner.displayName} (@{item.owner.handle})
        </Text>
        {item.topics.length > 0 ? (
          <View style={styles.topics}>
            {item.topics.map((topic) => (
              <Pill key={topic} label={`#${topic}`} tone="tint" />
            ))}
          </View>
        ) : null}
      </Padded>

      {item.canPropose ? (
        <Padded>
          <Button
            title="Send a proposal"
            icon="paperplane.fill"
            onPress={() =>
              router.push(
                `/propose?${new URLSearchParams({
                  to: item.owner.userId,
                  kind,
                  targetId: item.id,
                  title: item.title,
                  ...(props.kind === "product" && props.item.preferredSplitBuilderPct !== null
                    ? { builderPct: String(props.item.preferredSplitBuilderPct) }
                    : {}),
                }).toString()}`,
              )
            }
          />
        </Padded>
      ) : null}

      {text.map(([label, value]) =>
        value ? (
          <Section key={label} title={label ?? ""}>
            <Padded>
              <Body>{value}</Body>
            </Padded>
          </Section>
        ) : null,
      )}

      {props.kind === "product" && props.item.demoUrl ? (
        <Section title="Demo">
          <Row icon="arrow.up.right.square" title={props.item.demoUrl} last />
        </Section>
      ) : null}

      <Section title="Details">
        {facts.map(([label, value], index) => (
          <Row key={label} title={label} detail={value} last={index === facts.length - 1} />
        ))}
      </Section>

      {item.isOwner ? (
        <Section
          title="Manage"
          footer={
            item.status === "in_collab" ? "It's in a collab now, so it can't be edited." : undefined
          }
        >
          {item.ownerActions.includes("publish") ? (
            <Row icon="paperplane" title="Publish" onPress={() => void change("publish")} />
          ) : null}
          {item.ownerActions.includes("restore") ? (
            <Row
              icon="arrow.uturn.backward"
              title="Restore as draft"
              onPress={() => void change("restore")}
            />
          ) : null}
          {item.ownerActions.includes("archive") ? (
            <Row
              icon="archivebox"
              title="Archive"
              destructive
              onPress={() =>
                Alert.alert(
                  "Archive it?",
                  "It stops showing in Discover. You can restore it later.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Archive",
                      style: "destructive",
                      onPress: () => void change("archive"),
                    },
                  ],
                )
              }
            />
          ) : null}
          <Row title="Status" detail={STATUS_LABELS[item.status] ?? item.status} last />
        </Section>
      ) : null}
      <View style={{ height: SPACING.xl }} />
    </>
  )
}

const styles = StyleSheet.create({
  title: { fontSize: 28, fontWeight: "700" },
  topics: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: SPACING.sm },
})
