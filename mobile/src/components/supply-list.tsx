import { ideaListOutput, productListOutput } from "@shared/schemas"
import { router, Stack } from "expo-router"
import { Pressable } from "react-native"

import { api } from "@/lib/api"
import { FORMAT_LABELS, formatMoney, formatRelative, STATUS_LABELS } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { Icon, Loaded, Message, Row, Screen, Section } from "@/ui/kit"

/** My ideas / My products (§12 `/app/ideas`, `/app/products`), with "+" for a new one. */
export function SupplyList({ kind }: { kind: "idea" | "product" }) {
  const state = useApi(async () =>
    kind === "idea"
      ? (await api(ideaListOutput, "GET", "/ideas")).items.map((item) => ({ ...item, stage: null }))
      : (await api(productListOutput, "GET", "/products")).items,
  )
  const noun = kind === "idea" ? "idea" : "product"
  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Stack.Screen
        options={{
          title: kind === "idea" ? "My ideas" : "My products",
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`New ${noun}`}
              hitSlop={10}
              onPress={() => router.push(`/supply-editor?kind=${kind}`)}
            >
              <Icon name="plus" size={22} />
            </Pressable>
          ),
        }}
      />
      <Loaded state={state}>
        {(items) =>
          items.length === 0 ? (
            <Message
              icon={kind === "idea" ? "lightbulb" : "shippingbox"}
              title={`No ${noun}s yet`}
              body={
                kind === "idea"
                  ? "Post what your audience keeps asking for; builders propose to build it."
                  : "List what you've built; creators propose to bring it to their audience."
              }
              action={{
                title: `New ${noun}`,
                onPress: () => router.push(`/supply-editor?kind=${kind}`),
              }}
            />
          ) : (
            <Section>
              {items.map((item, index) => (
                <Row
                  key={item.id}
                  title={item.title}
                  subtitle={`${STATUS_LABELS[item.status] ?? item.status} · ${FORMAT_LABELS[item.format] ?? item.format} · ${formatMoney(
                    item.targetPriceCents,
                    item.currency,
                  )}\nUpdated ${formatRelative(item.updatedAt)}`}
                  onPress={() =>
                    router.push(kind === "idea" ? `/idea/${item.id}` : `/product/${item.id}`)
                  }
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
