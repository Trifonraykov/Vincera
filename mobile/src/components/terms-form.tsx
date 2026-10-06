import { useState } from "react"
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native"

import { ApiError, errorMessage } from "@/lib/api"
import { notifyError } from "@/lib/haptics"
import { Button, Field, Segmented } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * The terms of an offer (scope, split, timeline, message), for a new proposal and a
 * counter-offer, presented in a native form sheet. The server checks the same rules as the web
 * (splits add up to 100, a timeline of whole weeks) and its messages land next to the fields.
 */

export type Terms = {
  scope: string
  message: string
  creatorSplitPct: number
  builderSplitPct: number
  timelineWeeks: string
}

const SPLITS = [40, 50, 60, 70, 80] as const

export function TermsForm({
  initial,
  submitLabel,
  intro,
  onSubmit,
}: {
  initial: Terms
  submitLabel: string
  intro?: string
  onSubmit: (terms: Terms) => Promise<void>
}) {
  const theme = useTheme()
  const [terms, setTerms] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const setCreator = (value: number) =>
    setTerms((current) => ({ ...current, creatorSplitPct: value, builderSplitPct: 100 - value }))

  async function submit() {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await onSubmit(terms)
    } catch (caught) {
      notifyError()
      if (caught instanceof ApiError) setError(caught)
      setMessage(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const splitOptions = SPLITS.map((value) => ({
    value: String(value),
    label: `${value}/${100 - value}`,
  }))
  const currentSplit = String(terms.creatorSplitPct)

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1 }}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
      >
        {intro ? (
          <Text style={[styles.intro, { color: theme.secondaryLabel }]}>{intro}</Text>
        ) : null}
        <Field
          label="What you'll build together"
          value={terms.scope}
          onChangeText={(scope) => setTerms({ ...terms, scope })}
          multiline
          placeholder="The product, what's in the first version, who does what."
          error={error?.field("scope")}
        />
        <View style={styles.split}>
          <Text style={[styles.label, { color: theme.secondaryLabel }]}>
            Split: creator {terms.creatorSplitPct}% · builder {terms.builderSplitPct}%
          </Text>
          <Segmented
            options={
              splitOptions.some((option) => option.value === currentSplit)
                ? splitOptions
                : [
                    ...splitOptions,
                    { value: currentSplit, label: `${currentSplit}/${100 - Number(currentSplit)}` },
                  ]
            }
            value={currentSplit}
            onChange={(value) => setCreator(Number(value))}
          />
          <View style={styles.stepper}>
            <Button
              title="Creator −5"
              kind="tinted"
              disabled={terms.creatorSplitPct < 5}
              onPress={() => setCreator(terms.creatorSplitPct - 5)}
            />
            <Button
              title="Creator +5"
              kind="tinted"
              disabled={terms.creatorSplitPct > 95}
              onPress={() => setCreator(terms.creatorSplitPct + 5)}
            />
          </View>
          {error?.field("creatorSplitPct") ? (
            <Text style={{ color: theme.destructive }}>{error.field("creatorSplitPct")}</Text>
          ) : null}
        </View>
        <Field
          label="Timeline (weeks)"
          value={terms.timelineWeeks}
          onChangeText={(timelineWeeks) => setTerms({ ...terms, timelineWeeks })}
          keyboardType="number-pad"
          error={error?.field("timelineWeeks")}
        />
        <Field
          label="Message (optional)"
          value={terms.message}
          onChangeText={(value) => setTerms({ ...terms, message: value })}
          multiline
          error={error?.field("message")}
        />
        {message ? (
          <Text accessibilityLiveRegion="polite" style={{ color: theme.destructive }}>
            {message}
          </Text>
        ) : null}
        <Button
          title={submitLabel}
          busy={busy}
          icon="paperplane.fill"
          onPress={() => void submit()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  content: { padding: SPACING.lg, gap: SPACING.lg, paddingBottom: SPACING.xl * 2 },
  intro: { fontSize: 15, lineHeight: 21 },
  split: { gap: SPACING.sm },
  label: { fontSize: 13, marginLeft: 4 },
  stepper: { flexDirection: "row", gap: SPACING.sm, justifyContent: "center" },
})
