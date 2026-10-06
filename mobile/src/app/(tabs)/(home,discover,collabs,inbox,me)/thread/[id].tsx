import { markReadOutput, postMessageOutput, threadOutput, type Message } from "@shared/schemas"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { useEffect, useRef, useState } from "react"
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { api, errorMessage } from "@/lib/api"
import { useAuth, useMe } from "@/lib/auth"
import { formatRelative } from "@/lib/format"
import { tapLight } from "@/lib/haptics"
import { useApi } from "@/lib/use-api"
import { Icon, Loaded } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * A conversation (a proposal's or a collab's thread): chat bubbles, newest at the bottom, and a
 * composer for text. Opening it marks it read up to the newest message shown (§19.30).
 */
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const me = useMe()
  const { refreshMe } = useAuth()
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const state = useApi(() => api(threadOutput, "GET", `/threads/${id}`), id)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const list = useRef<FlatList<Message>>(null)

  const newest = state.data?.messages.at(-1)?.id
  useEffect(() => {
    if (!newest) return
    void api(markReadOutput, "POST", `/threads/${id}/read`, { messageId: newest })
      .then((result) => (result.changed ? refreshMe() : undefined))
      .catch(() => undefined)
  }, [id, newest, refreshMe])

  async function send() {
    const body = draft.trim()
    if (!body) return
    setSending(true)
    try {
      await api(postMessageOutput, "POST", `/threads/${id}/messages`, { body })
      tapLight()
      setDraft("")
      await state.reload()
      requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }))
    } catch (error) {
      Alert.alert("Message not sent", errorMessage(error))
    } finally {
      setSending(false)
    }
  }

  const data = state.data
  const nameOf = (userId: string) =>
    data?.participants.find((party) => party.userId === userId)?.name ?? "Someone"

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 100 : 0}
      style={{ flex: 1, backgroundColor: theme.background }}
    >
      <Stack.Screen
        options={{
          title: data?.title ?? "Messages",
          headerLargeTitleEnabled: false,
          headerRight: data?.parentId
            ? () => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    data.kind === "collab" ? "Open the collab" : "Open the proposal"
                  }
                  hitSlop={10}
                  onPress={() =>
                    router.push(
                      data.kind === "collab"
                        ? `/collab/${data.parentId}`
                        : `/proposal/${data.parentId}`,
                    )
                  }
                >
                  <Icon name="info.circle" size={22} />
                </Pressable>
              )
            : undefined,
        }}
      />
      <Loaded state={state}>
        {(thread) => (
          <FlatList
            ref={list}
            data={thread.messages}
            keyExtractor={(message) => message.id}
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.sm }}
            onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
            ListHeaderComponent={
              thread.olderCount > 0 ? (
                <Text style={[styles.meta, { color: theme.secondaryLabel, textAlign: "center" }]}>
                  {thread.olderCount} earlier messages are on the web.
                </Text>
              ) : null
            }
            ListEmptyComponent={
              <Text style={[styles.meta, { color: theme.secondaryLabel, textAlign: "center" }]}>
                No messages yet. Say hello.
              </Text>
            }
            renderItem={({ item }) => {
              const mine = item.authorUserId === me.id
              return (
                <View style={[styles.bubbleRow, mine ? styles.mine : styles.theirs]}>
                  {!mine ? (
                    <Text style={[styles.meta, { color: theme.secondaryLabel }]}>
                      {nameOf(item.authorUserId)}
                    </Text>
                  ) : null}
                  <View
                    style={[styles.bubble, { backgroundColor: mine ? theme.tint : theme.card }]}
                  >
                    <Text style={[styles.text, { color: mine ? "#FFFFFF" : theme.label }]}>
                      {item.body}
                    </Text>
                    {item.attachments.map((file) => (
                      <Text
                        key={file.filename}
                        style={[styles.meta, { color: mine ? "#FFFFFFCC" : theme.secondaryLabel }]}
                      >
                        📎 {file.filename}
                      </Text>
                    ))}
                  </View>
                  <Text style={[styles.meta, { color: theme.tertiaryLabel }]}>
                    {formatRelative(item.createdAt)}
                  </Text>
                </View>
              )
            }}
          />
        )}
      </Loaded>
      {data?.canPost ? (
        <View
          style={[
            styles.composer,
            {
              backgroundColor: theme.card,
              borderTopColor: theme.separator,
              paddingBottom: Math.max(insets.bottom, SPACING.sm),
            },
          ]}
        >
          <TextInput
            accessibilityLabel="Message"
            value={draft}
            onChangeText={setDraft}
            placeholder="Message"
            placeholderTextColor={theme.tertiaryLabel}
            multiline
            style={[
              styles.input,
              {
                color: theme.label,
                backgroundColor: theme.background,
                borderColor: theme.separator,
              },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={sending || draft.trim() === ""}
            onPress={() => void send()}
            hitSlop={8}
            style={{ opacity: sending || draft.trim() === "" ? 0.4 : 1 }}
          >
            <Icon name="arrow.up.circle.fill" size={32} />
          </Pressable>
        </View>
      ) : data ? (
        <Text
          style={[
            styles.closed,
            { color: theme.secondaryLabel, paddingBottom: insets.bottom + SPACING.lg },
          ]}
        >
          This conversation is closed.
        </Text>
      ) : null}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  bubbleRow: { maxWidth: "82%", gap: 2 },
  mine: { alignSelf: "flex-end", alignItems: "flex-end" },
  theirs: { alignSelf: "flex-start", alignItems: "flex-start" },
  bubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
  text: { fontSize: 17, lineHeight: 22 },
  meta: { fontSize: 12 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    fontSize: 17,
    maxHeight: 120,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  closed: { textAlign: "center", padding: SPACING.lg },
})
