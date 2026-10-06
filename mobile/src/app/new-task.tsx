import { taskChangedOutput, taskListOutput } from "@shared/schemas"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { useState } from "react"
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native"

import { api, ApiError, errorMessage } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/haptics"
import { useApi } from "@/lib/use-api"
import { Button, Field, Segmented } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/** New task (§12 tasks) in a native sheet: title, notes, who does it, due date. */
export default function NewTaskSheet() {
  const { collabId } = useLocalSearchParams<{ collabId: string }>()
  const theme = useTheme()
  const members = useApi(() => api(taskListOutput, "GET", `/collabs/${collabId}/tasks`), collabId)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [assignee, setAssignee] = useState("")
  const [dueDate, setDueDate] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await api(taskChangedOutput, "POST", `/collabs/${collabId}/tasks`, {
        title,
        description,
        assigneeUserId: assignee,
        dueDate,
      })
      notifySuccess()
      router.back()
    } catch (caught) {
      notifyError()
      if (caught instanceof ApiError) setError(caught)
      setMessage(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const options = [
    { value: "", label: "Nobody" },
    ...(members.data?.members.map((member) => ({ value: member.userId, label: member.name })) ??
      []),
  ]

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1 }}
    >
      <Stack.Screen options={{ title: "New task" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.lg }}
      >
        <Field
          label="Title"
          value={title}
          onChangeText={setTitle}
          autoFocus
          returnKeyType="done"
          error={error?.field("title")}
        />
        <Field
          label="Notes (optional)"
          value={description}
          onChangeText={setDescription}
          multiline
          error={error?.field("description")}
        />
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.secondaryLabel, fontSize: 13, marginLeft: 4 }}>
            Who does it
          </Text>
          <Segmented options={options} value={assignee} onChange={setAssignee} />
          {error?.field("assigneeUserId") ? (
            <Text style={{ color: theme.destructive }}>{error.field("assigneeUserId")}</Text>
          ) : null}
        </View>
        <Field
          label="Due date (optional)"
          value={dueDate}
          onChangeText={setDueDate}
          placeholder="YYYY-MM-DD"
          keyboardType="numbers-and-punctuation"
          error={error?.field("dueDate")}
        />
        {message ? <Text style={{ color: theme.destructive }}>{message}</Text> : null}
        <Button
          title="Add task"
          busy={busy}
          disabled={title.trim() === ""}
          onPress={() => void save()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
