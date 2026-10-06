import { okSchema, taskChangedOutput, taskListOutput, type Task } from "@shared/schemas"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native"

import { api, errorMessage } from "@/lib/api"
import { formatDate } from "@/lib/format"
import { notifySuccess, selectionTick } from "@/lib/haptics"
import { useApi } from "@/lib/use-api"
import { Icon, Loaded, Message, Screen, Section } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * A collab's tasks (§12 `/app/collabs/[id]/tasks`): tap the circle to complete or reopen, long
 * press for move and delete, "+" for a new task in a native sheet. Ended collabs are read-only.
 */
export default function TasksScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const theme = useTheme()
  const state = useApi(() => api(taskListOutput, "GET", `/collabs/${id}/tasks`), id)
  const canWork = state.data?.canWork ?? false

  async function run(path: string, method: "POST" | "DELETE", body?: unknown) {
    try {
      await api(method === "DELETE" ? okSchema : taskChangedOutput, method, path, body)
      selectionTick()
      await state.reload()
    } catch (error) {
      Alert.alert("Couldn't update the task", errorMessage(error))
    }
  }

  function more(task: Task) {
    const options = ["Move up", "Move down", "Delete", "Cancel"]
    const pick = (index: number) => {
      if (index === 0) void run(`/tasks/${task.id}/move`, "POST", { direction: "up" })
      if (index === 1) void run(`/tasks/${task.id}/move`, "POST", { direction: "down" })
      if (index === 2) {
        Alert.alert("Delete this task?", task.title, [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => void run(`/tasks/${task.id}`, "DELETE"),
          },
        ])
      }
    }
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, destructiveButtonIndex: 2, cancelButtonIndex: 3, title: task.title },
        pick,
      )
    } else {
      Alert.alert(task.title, undefined, [
        { text: "Move up", onPress: () => pick(0) },
        { text: "Move down", onPress: () => pick(1) },
        { text: "Delete", style: "destructive", onPress: () => pick(2) },
        { text: "Cancel", style: "cancel" },
      ])
    }
  }

  const nameOf = (userId: string | null) =>
    userId
      ? (state.data?.members.find((member) => member.userId === userId)?.name ?? "Someone")
      : null

  const renderTask = (task: Task, index: number, list: Task[]) => {
    const done = task.doneAt !== null
    const assignee = nameOf(task.assigneeUserId)
    return (
      <Pressable
        key={task.id}
        onLongPress={canWork ? () => more(task) : undefined}
        accessibilityHint={canWork ? "Long press for more actions" : undefined}
        style={[
          styles.task,
          index < list.length - 1 && {
            borderBottomColor: theme.separator,
            borderBottomWidth: StyleSheet.hairlineWidth,
          },
        ]}
      >
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: done, disabled: !canWork }}
          accessibilityLabel={task.title}
          disabled={!canWork}
          hitSlop={8}
          onPress={() => {
            if (!done) notifySuccess()
            void run(`/tasks/${task.id}/done`, "POST", { done: !done })
          }}
          style={styles.check}
        >
          <Icon
            name={done ? "checkmark.circle.fill" : "circle"}
            size={24}
            color={done ? theme.success : theme.tertiaryLabel}
          />
        </Pressable>
        <View style={styles.taskText}>
          <Text
            style={[
              styles.taskTitle,
              { color: done ? theme.secondaryLabel : theme.label },
              done && styles.strike,
            ]}
          >
            {task.title}
          </Text>
          {task.description ? (
            <Text style={{ color: theme.secondaryLabel }} numberOfLines={2}>
              {task.description}
            </Text>
          ) : null}
          {assignee || task.dueDate ? (
            <Text style={{ color: theme.secondaryLabel, fontSize: 13 }}>
              {[assignee, task.dueDate ? `due ${formatDate(`${task.dueDate}T00:00:00Z`)}` : null]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          ) : null}
        </View>
      </Pressable>
    )
  }

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Stack.Screen
        options={{
          title: "Tasks",
          headerRight: canWork
            ? () => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="New task"
                  hitSlop={10}
                  onPress={() => router.push(`/new-task?collabId=${id}`)}
                >
                  <Icon name="plus" size={22} />
                </Pressable>
              )
            : undefined,
        }}
      />
      <Loaded state={state}>
        {(data) =>
          data.open.length + data.done.length === 0 ? (
            <Message
              icon="checklist"
              title="No tasks yet"
              body="Plan the work together: who does what, by when."
              action={
                canWork
                  ? { title: "Add a task", onPress: () => router.push(`/new-task?collabId=${id}`) }
                  : undefined
              }
            />
          ) : (
            <>
              <Section
                title={`Open · ${data.open.length}`}
                footer={
                  canWork
                    ? "Long press a task to move or delete it."
                    : "This collab has ended; its tasks are read-only."
                }
              >
                {data.open.length === 0 ? (
                  <View style={styles.task}>
                    <Text style={{ color: theme.secondaryLabel }}>Everything is done.</Text>
                  </View>
                ) : (
                  data.open.map((task, index) => renderTask(task, index, data.open))
                )}
              </Section>
              {data.done.length > 0 ? (
                <Section title={`Done · ${data.done.length}`}>
                  {data.done.map((task, index) => renderTask(task, index, data.done))}
                </Section>
              ) : null}
            </>
          )
        }
      </Loaded>
    </Screen>
  )
}

const styles = StyleSheet.create({
  task: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.md,
    padding: SPACING.lg,
    minHeight: 44,
  },
  check: { paddingTop: 1 },
  taskText: { flex: 1, gap: 2 },
  taskTitle: { fontSize: 17 },
  strike: { textDecorationLine: "line-through" },
})
