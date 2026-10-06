import { inboxOutput } from "@shared/schemas"
import { router } from "expo-router"

import { api } from "@/lib/api"
import { formatRelative } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { Loaded, Message, Row, Screen, Section } from "@/ui/kit"

/** Inbox (§12 `/app/messages`): every conversation, newest first, plus Notifications. */
export default function InboxScreen() {
  const state = useApi(() => api(inboxOutput, "GET", "/inbox"))
  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Loaded state={state}>
        {(inbox) => (
          <>
            <Section>
              <Row
                icon="bell"
                title="Notifications"
                badge={inbox.unreadNotifications}
                onPress={() => router.push("/notifications")}
                last
              />
            </Section>
            {inbox.threads.length === 0 ? (
              <Message
                icon="bubble.left.and.bubble.right"
                title="No conversations yet"
                body="Each proposal and collab has its own conversation."
              />
            ) : (
              <Section title="Messages">
                {inbox.threads.map((thread, index) => (
                  <Row
                    key={thread.id}
                    icon={thread.kind === "collab" ? "person.2" : "paperplane"}
                    title={thread.title}
                    subtitle={`${thread.with.join(", ")}${
                      thread.preview
                        ? `\n${thread.previewByUser ? "You: " : ""}${thread.preview}`
                        : ""
                    }`}
                    detail={formatRelative(thread.lastMessageAt)}
                    badge={thread.unread}
                    onPress={() => router.push(`/thread/${thread.id}`)}
                    last={index === inbox.threads.length - 1}
                  />
                ))}
              </Section>
            )}
          </>
        )}
      </Loaded>
    </Screen>
  )
}
