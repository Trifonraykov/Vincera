import { feedOutput, markShownOutput, type FeedItemWire } from "@shared/schemas"
import { router, Stack } from "expo-router"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native"

import { BottomShade, HeartButton, ListingCover, ListingIcon } from "@/components/listing"
import { api, errorMessage } from "@/lib/api"
import { formatCount } from "@/lib/format"
import { Icon, Message } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * The creator feed (CLAUDE.md §19.45): one column of big picture cards that scrolls like any list
 * (not swipe cards). Icon, name, @builder, one line, one tag and the rating sit on a soft shade at
 * the bottom; the heart saves; a tap opens the listing. Pull to refresh; the next page loads as
 * the end comes near; each page records what was on screen.
 */
export default function FeedScreen() {
  const theme = useTheme()
  const { width } = useWindowDimensions()
  const [items, setItems] = useState<FeedItemWire[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "error">("loading")
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const pages = useRef(0)

  const recordShown = useCallback((page: FeedItemWire[], offset: number) => {
    if (page.length === 0) return
    pages.current += 1
    void api(markShownOutput, "POST", "/feed/shown", {
      page: pages.current,
      items: page.map((item, index) => ({
        productId: item.id,
        matchId: item.matchId,
        rank: offset + index + 1,
      })),
    }).catch(() => undefined)
  }, [])

  const loadFirst = useCallback(async () => {
    try {
      const result = await api(feedOutput, "GET", "/feed")
      setItems(result.items)
      setCursor(result.nextCursor)
      setState("ready")
      setError(null)
      pages.current = 0
      recordShown(result.items, 0)
    } catch (caught) {
      setError(errorMessage(caught))
      setState((current) => (current === "ready" ? current : "error"))
    }
  }, [recordShown])

  useEffect(() => {
    // After the first render: the load sets state when its answer arrives.
    void Promise.resolve().then(loadFirst)
  }, [loadFirst])

  async function loadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const result = await api(feedOutput, "GET", `/feed?cursor=${encodeURIComponent(cursor)}`)
      const offset = items.length
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id))
        return [...current, ...result.items.filter((item) => !seen.has(item.id))]
      })
      setCursor(result.nextCursor)
      recordShown(result.items, offset)
    } catch {
      // The next scroll tries again.
    } finally {
      setLoadingMore(false)
    }
  }

  const cardWidth = Math.min(width - SPACING.lg * 2, 560)

  return (
    <>
      <Stack.Screen
        options={{
          title: "For you",
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Discover"
              hitSlop={10}
              onPress={() => router.push("/discover")}
            >
              <Icon name="safari" size={22} />
            </Pressable>
          ),
        }}
      />
      {state === "loading" ? (
        <View style={[styles.center, { backgroundColor: theme.background }]}>
          <ActivityIndicator />
        </View>
      ) : state === "error" ? (
        <View style={{ flex: 1, backgroundColor: theme.background }}>
          <Message
            icon="exclamationmark.triangle"
            title="Couldn't load the feed"
            body={error ?? undefined}
            action={{ title: "Try again", onPress: () => void loadFirst() }}
          />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentInsetAdjustmentBehavior="automatic"
          style={{ backgroundColor: theme.background }}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: SPACING.lg }} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true)
                await loadFirst()
                setRefreshing(false)
              }}
            />
          }
          onEndReachedThreshold={1.5}
          onEndReached={() => void loadMore()}
          initialNumToRender={3}
          windowSize={7}
          ListEmptyComponent={
            <Message
              icon="sparkles"
              title="Nothing new right now"
              body="When builders list products, they show up here first."
            />
          }
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator style={{ marginVertical: SPACING.xl }} />
            ) : items.length > 0 && !cursor ? (
              <Text style={[styles.end, { color: theme.secondaryLabel }]}>
                You&apos;re all caught up.
              </Text>
            ) : null
          }
          renderItem={({ item, index }) => (
            <FeedCard item={item} rank={index + 1} width={cardWidth} />
          )}
        />
      )}
    </>
  )
}

function FeedCard({ item, rank, width }: { item: FeedItemWire; rank: number; width: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title} by @${item.builder.handle}`}
      accessibilityHint="Opens the product"
      onPress={() => router.push(`/listing/${item.id}?rank=${rank}`)}
      style={({ pressed }) => [
        styles.card,
        { width, height: width * 1.25 },
        pressed && { transform: [{ scale: 0.985 }] },
      ]}
    >
      <ListingCover listing={item} priority={rank <= 2 ? "high" : "normal"} />
      <BottomShade />
      <View style={styles.heartSlot}>
        <HeartButton productId={item.id} title={item.title} saved={item.saved} rank={rank} />
      </View>
      <View style={styles.info}>
        <View style={styles.titleRow}>
          <ListingIcon listing={item} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={styles.title}>
              {item.title}
            </Text>
            <Text numberOfLines={1} style={styles.handle}>
              @{item.builder.handle}
            </Text>
          </View>
        </View>
        {item.hook ? (
          <Text numberOfLines={2} style={styles.hook}>
            {item.hook}
          </Text>
        ) : null}
        <View style={styles.meta}>
          <Text style={styles.tag}>{item.tag}</Text>
          {item.rating !== null ? (
            <Text style={styles.rating}>
              ★ {item.rating.toFixed(1)}
              {item.ratingCount ? (
                <Text style={styles.ratingCount}> ({formatCount(item.ratingCount)})</Text>
              ) : null}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: SPACING.lg, alignItems: "center" },
  card: { borderRadius: 28, overflow: "hidden", backgroundColor: "#1C1C1E" },
  heartSlot: { position: "absolute", top: 12, right: 12 },
  info: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 20, gap: 10 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { color: "#FFFFFF", fontSize: 19, fontWeight: "600" },
  handle: { color: "rgba(255,255,255,0.75)", fontSize: 14, marginTop: 2 },
  hook: { color: "rgba(255,255,255,0.92)", fontSize: 15, lineHeight: 20 },
  meta: { flexDirection: "row", alignItems: "center", gap: 10 },
  tag: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "500",
    backgroundColor: "rgba(255,255,255,0.18)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden",
  },
  rating: { color: "rgba(255,255,255,0.88)", fontSize: 13 },
  ratingCount: { color: "rgba(255,255,255,0.6)" },
  end: { textAlign: "center", marginVertical: SPACING.xl },
})
