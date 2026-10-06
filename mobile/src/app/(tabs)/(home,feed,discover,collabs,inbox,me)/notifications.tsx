import {
  markAllReadOutput,
  notificationListOutput,
  okSchema,
  type NotificationItem,
} from "@shared/schemas"
import { router, Stack } from "expo-router"
import * as WebBrowser from "expo-web-browser"
import { Text } from "react-native"

import { api } from "@/lib/api"
import { useAuth, useMe } from "@/lib/auth"
import { formatRelative } from "@/lib/format"
import { selectionTick } from "@/lib/haptics"
import { useApi } from "@/lib/use-api"
import { Loaded, Message, Row, Screen, Section } from "@/ui/kit"
import { useTheme } from "@/ui/theme"

/** The web path a notification leads to → the native screen for it, when the app has one. */
function nativeRoute(href: string): string | null {
  const proposal = href.match(/^\/app\/proposals\/([0-9a-f-]{36})/)
  if (proposal) return `/proposal/${proposal[1]}`
  const agreement = href.match(/^\/app\/collabs\/([0-9a-f-]{36})\/agreement/)
  if (agreement) return `/collab/${agreement[1]}/agreement`
  const tasks = href.match(/^\/app\/collabs\/([0-9a-f-]{36})\/tasks/)
  if (tasks) return `/collab/${tasks[1]}/tasks`
  const collab = href.match(/^\/app\/collabs\/([0-9a-f-]{36})/)
  if (collab) return `/collab/${collab[1]}`
  if (href.startsWith("/app/earnings")) return "/earnings"
  if (href.startsWith("/app/audience")) return "/audience"
  return null
}

/** Notifications (§12 `/app/notifications`): newest first; opening one marks it read. */
export default function NotificationsScreen() {
  const me = useMe()
  const { refreshMe } = useAuth()
  const theme = useTheme()
  const state = useApi(() => api(notificationListOutput, "GET", "/notifications"))

  async function open(item: NotificationItem) {
    if (!item.readAt) {
      await api(okSchema, "POST", `/notifications/${item.id}/read`).catch(() => undefined)
      void refreshMe().catch(() => undefined)
    }
    const route = nativeRoute(item.href)
    if (route) router.push(route as never)
    else await WebBrowser.openBrowserAsync(new URL(item.href, me.webUrl).toString())
  }

  async function markAll() {
    await api(markAllReadOutput, "POST", "/notifications/read-all").catch(() => undefined)
    selectionTick()
    void refreshMe().catch(() => undefined)
    await state.reload()
  }

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Stack.Screen
        options={{
          title: "Notifications",
          headerRight:
            (state.data?.unread ?? 0) > 0
              ? () => (
                  <Text
                    accessibilityRole="button"
                    onPress={() => void markAll()}
                    style={{ color: theme.tint, fontSize: 17 }}
                  >
                    Read all
                  </Text>
                )
              : undefined,
        }}
      />
      <Loaded state={state}>
        {({ items }) =>
          items.length === 0 ? (
            <Message
              icon="bell"
              title="You're all caught up"
              body="Proposals, agreements and tasks show up here."
            />
          ) : (
            <Section>
              {items.map((item, index) => (
                <Row
                  key={item.id}
                  icon={item.readAt ? "bell" : "bell.fill"}
                  iconColor={item.readAt ? theme.tertiaryLabel : theme.tint}
                  title={item.title}
                  subtitle={[item.body, formatRelative(item.createdAt)].filter(Boolean).join("\n")}
                  onPress={() => void open(item)}
                  last={index === items.length - 1}
                />
              ))}
            </Section>
          )
        }
      </Loaded>
    </Screen>
  )
}
