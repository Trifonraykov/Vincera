import {
  ideaDetailSchema,
  PRODUCT_FORMAT_VALUES,
  PRODUCT_STAGE_VALUES,
  productDetailSchema,
  supplySavedOutput,
} from "@shared/schemas"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { useEffect, useState } from "react"
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native"

import { api, ApiError, errorMessage } from "@/lib/api"
import { FORMAT_LABELS, STAGE_LABELS } from "@/lib/format"
import { notifyError, notifySuccess, selectionTick } from "@/lib/haptics"
import { Button, Field, Loading } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * Create or edit an idea (creators) or a product (builders) in a full-height sheet. "Publish"
 * needs what the web needs (a problem or description, and a topic); the server says what's
 * missing next to the field.
 */

type Form = {
  title: string
  problem: string
  audienceEvidence: string
  description: string
  targetUser: string
  stage: string
  demoUrl: string
  format: string
  targetPrice: string
  topics: string
  preferredSplitBuilderPct: string
  exclusivity: boolean
}

const EMPTY: Form = {
  title: "",
  problem: "",
  audienceEvidence: "",
  description: "",
  targetUser: "",
  stage: "prototype",
  demoUrl: "",
  format: "app",
  targetPrice: "",
  topics: "",
  preferredSplitBuilderPct: "",
  exclusivity: false,
}

const price = (cents: number | null) =>
  cents === null ? "" : cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)

function Chips({
  options,
  value,
  onChange,
}: {
  options: readonly { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
}) {
  const theme = useTheme()
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chips}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => {
              selectionTick()
              onChange(option.value)
            }}
            style={[styles.chip, { backgroundColor: selected ? theme.tint : theme.fill }]}
          >
            <Text style={{ color: selected ? "#FFFFFF" : theme.label, fontSize: 15 }}>
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

export default function SupplyEditor() {
  const { kind, id } = useLocalSearchParams<{ kind: "idea" | "product"; id?: string }>()
  const theme = useTheme()
  const [form, setForm] = useState<Form | null>(id ? null : EMPTY)
  const [status, setStatus] = useState<string>("draft")
  const [busy, setBusy] = useState<"save" | "publish" | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const path = kind === "idea" ? "/ideas" : "/products"

  useEffect(() => {
    if (!id) return
    void (async () => {
      try {
        if (kind === "idea") {
          const idea = await api(ideaDetailSchema, "GET", `/ideas/${id}`)
          setStatus(idea.status)
          setForm({
            ...EMPTY,
            title: idea.title,
            problem: idea.problem ?? "",
            audienceEvidence: idea.audienceEvidence ?? "",
            format: idea.format,
            targetPrice: price(idea.targetPriceCents),
            topics: idea.topics.join(", "),
          })
        } else {
          const product = await api(productDetailSchema, "GET", `/products/${id}`)
          setStatus(product.status)
          setForm({
            ...EMPTY,
            title: product.title,
            description: product.description ?? "",
            targetUser: product.targetUser ?? "",
            stage: product.stage,
            demoUrl: product.demoUrl ?? "",
            format: product.format,
            targetPrice: price(product.targetPriceCents),
            topics: product.topics.join(", "),
            preferredSplitBuilderPct:
              product.preferredSplitBuilderPct === null
                ? ""
                : String(product.preferredSplitBuilderPct),
            exclusivity: product.exclusivity,
          })
        }
      } catch (caught) {
        setMessage(errorMessage(caught))
        setForm(EMPTY)
      }
    })()
  }, [id, kind])

  if (!form) return <Loading />
  const set =
    <K extends keyof Form>(key: K) =>
    (value: Form[K]) =>
      setForm({ ...form, [key]: value })

  async function submit(intent: "save" | "publish") {
    if (!form) return
    setBusy(intent)
    setError(null)
    setMessage(null)
    const body =
      kind === "idea"
        ? {
            title: form.title,
            problem: form.problem,
            audienceEvidence: form.audienceEvidence,
            format: form.format,
            targetPrice: form.targetPrice,
            topics: form.topics,
            intent,
          }
        : {
            title: form.title,
            description: form.description,
            targetUser: form.targetUser,
            stage: form.stage,
            demoUrl: form.demoUrl,
            format: form.format,
            targetPrice: form.targetPrice,
            topics: form.topics,
            preferredSplitBuilderPct: form.preferredSplitBuilderPct,
            exclusivity: form.exclusivity,
            intent,
          }
    try {
      const result = id
        ? await api(supplySavedOutput, "PATCH", `${path}/${id}`, body)
        : await api(supplySavedOutput, "POST", path, body)
      notifySuccess()
      router.back()
      if (!id) router.push(kind === "idea" ? `/idea/${result.id}` : `/product/${result.id}`)
    } catch (caught) {
      notifyError()
      if (caught instanceof ApiError) setError(caught)
      setMessage(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const isDraft = status === "draft"
  const noun = kind === "idea" ? "idea" : "product"

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1 }}
    >
      <Stack.Screen options={{ title: id ? `Edit ${noun}` : `New ${noun}` }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
      >
        <Field
          label="Title"
          value={form.title}
          onChangeText={set("title")}
          error={error?.field("title")}
        />
        {kind === "idea" ? (
          <>
            <Field
              label="The problem"
              hint="What your audience struggles with."
              value={form.problem}
              onChangeText={set("problem")}
              multiline
              error={error?.field("problem")}
            />
            <Field
              label="Audience evidence (optional)"
              hint="Comments, polls, DMs that show the demand."
              value={form.audienceEvidence}
              onChangeText={set("audienceEvidence")}
              multiline
              error={error?.field("audienceEvidence")}
            />
          </>
        ) : (
          <>
            <Field
              label="Description"
              value={form.description}
              onChangeText={set("description")}
              multiline
              error={error?.field("description")}
            />
            <Field
              label="Who it's for (optional)"
              value={form.targetUser}
              onChangeText={set("targetUser")}
              error={error?.field("targetUser")}
            />
            <View style={styles.group}>
              <Text style={[styles.label, { color: theme.secondaryLabel }]}>Stage</Text>
              <Chips
                options={PRODUCT_STAGE_VALUES.map((value) => ({
                  value,
                  label: STAGE_LABELS[value] ?? value,
                }))}
                value={form.stage}
                onChange={set("stage")}
              />
            </View>
            <Field
              label="Demo link (optional)"
              value={form.demoUrl}
              onChangeText={set("demoUrl")}
              autoCapitalize="none"
              keyboardType="url"
              error={error?.field("demoUrl")}
            />
          </>
        )}
        <View style={styles.group}>
          <Text style={[styles.label, { color: theme.secondaryLabel }]}>Format</Text>
          <Chips
            options={PRODUCT_FORMAT_VALUES.map((value) => ({
              value,
              label: FORMAT_LABELS[value] ?? value,
            }))}
            value={form.format}
            onChange={set("format")}
          />
          {error?.field("format") ? (
            <Text style={{ color: theme.destructive }}>{error.field("format")}</Text>
          ) : null}
        </View>
        <Field
          label="Target price in euros (optional)"
          placeholder="19 or 19,99"
          value={form.targetPrice}
          onChangeText={set("targetPrice")}
          keyboardType="decimal-pad"
          error={error?.field("targetPrice")}
        />
        <Field
          label="Topics"
          hint="Comma separated, up to 8."
          value={form.topics}
          onChangeText={set("topics")}
          autoCapitalize="none"
          error={error?.field("topics")}
        />
        {kind === "product" ? (
          <>
            <Field
              label="Your preferred share (%) (optional)"
              value={form.preferredSplitBuilderPct}
              onChangeText={set("preferredSplitBuilderPct")}
              keyboardType="number-pad"
              error={error?.field("preferredSplitBuilderPct")}
            />
            <View style={[styles.switchRow, { backgroundColor: theme.card }]}>
              <Text style={{ color: theme.label, fontSize: 17, flex: 1 }}>
                Exclusive (one creator at a time)
              </Text>
              <Switch value={form.exclusivity} onValueChange={set("exclusivity")} />
            </View>
            {error?.field("exclusivity") ? (
              <Text style={{ color: theme.destructive }}>{error.field("exclusivity")}</Text>
            ) : null}
          </>
        ) : null}
        {message ? (
          <Text accessibilityLiveRegion="polite" style={{ color: theme.destructive }}>
            {message}
          </Text>
        ) : null}
        {isDraft ? (
          <>
            <Button
              title="Publish"
              icon="paperplane.fill"
              busy={busy === "publish"}
              onPress={() => void submit("publish")}
            />
            <Button
              title="Save draft"
              kind="tinted"
              busy={busy === "save"}
              onPress={() => void submit("save")}
            />
          </>
        ) : (
          <Button title="Save changes" busy={busy === "save"} onPress={() => void submit("save")} />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  content: { padding: SPACING.lg, gap: SPACING.lg, paddingBottom: SPACING.xl * 2 },
  group: { gap: 6 },
  label: { fontSize: 13, marginLeft: 4 },
  chips: { gap: SPACING.sm, paddingVertical: 2 },
  chip: { borderRadius: 999, paddingHorizontal: 14, minHeight: 36, justifyContent: "center" },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: SPACING.md,
    borderRadius: 10,
    gap: SPACING.md,
  },
})
