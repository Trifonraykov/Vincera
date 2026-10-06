import { feedDetailOutput, okSchema, type FeedDetail } from "@shared/schemas"
import { Image } from "expo-image"
import { router, Stack, useLocalSearchParams } from "expo-router"
import * as WebBrowser from "expo-web-browser"
import { useEffect, useState } from "react"
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { HeartButton, ListingCover, ListingIcon } from "@/components/listing"
import { api } from "@/lib/api"
import { formatCount } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { Button, Icon, Loaded } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * A listing (CLAUDE.md §19.45): a sideways pager of screenshots, the name and one line, a few
 * facts, the builder in brief, and one thing to do, pinned at the bottom: send a proposal.
 */
export default function ListingScreen() {
  const { id, rank } = useLocalSearchParams<{ id: string; rank?: string }>()
  const state = useApi(() => api(feedDetailOutput, "GET", `/feed/${id}`), id)
  const rankNumber = rank && /^\d+$/.test(rank) ? Number(rank) : null

  useEffect(() => {
    void api(okSchema, "POST", `/feed/${id}/open`, { rank: rankNumber }).catch(() => undefined)
  }, [id, rankNumber])

  return (
    <>
      <Stack.Screen options={{ title: state.data?.title ?? "", headerLargeTitleEnabled: false }} />
      <Loaded state={state}>
        {(listing) => <ListingBody listing={listing} rank={rankNumber} />}
      </Loaded>
    </>
  )
}

function ListingBody({ listing, rank }: { listing: FeedDetail; rank: number | null }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { width, height: screenHeight } = useWindowDimensions()
  const [expanded, setExpanded] = useState(false)
  // About half the screen, so the name and the button stay in view.
  const shotHeight = Math.min(400, Math.round(screenHeight * 0.48))
  const facts = [listing.tag, listing.priceLabel, listing.sourceLabel].filter(
    (fact): fact is string => !!fact,
  )
  const link = listing.sourceUrl ?? listing.demoUrl

  function propose() {
    router.push(
      `/propose?${new URLSearchParams({
        to: listing.builder.userId,
        kind: "product",
        targetId: listing.id,
        title: listing.title,
        ...(listing.matchId ? { matchId: listing.matchId } : {}),
      }).toString()}`,
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 120 + insets.bottom }}>
        {listing.screenshots.length > 0 ? (
          <FlatList
            horizontal
            data={listing.screenshots}
            keyExtractor={(shot) => shot.url}
            showsHorizontalScrollIndicator={false}
            decelerationRate="fast"
            snapToAlignment="start"
            snapToInterval={
              (listing.screenshots[0]?.width && listing.screenshots[0]?.height
                ? (shotHeight * listing.screenshots[0].width) / listing.screenshots[0].height
                : 250) + SPACING.md
            }
            contentContainerStyle={{ paddingHorizontal: SPACING.lg, gap: SPACING.md }}
            style={{ marginTop: SPACING.md }}
            renderItem={({ item, index }) => {
              const ratio = item.width && item.height ? item.width / item.height : 0.56
              const height = ratio > 1 ? 220 : shotHeight
              return (
                <Image
                  source={item.url}
                  accessibilityLabel={`${listing.title}, picture ${index + 1} of ${listing.screenshots.length}`}
                  style={[
                    styles.shot,
                    { height, width: Math.min(height * ratio, width - SPACING.lg * 2) },
                    { backgroundColor: listing.visual.from },
                  ]}
                  contentFit="cover"
                  transition={200}
                />
              )
            }}
          />
        ) : (
          <View style={[styles.coverFrame, { marginHorizontal: SPACING.lg }]}>
            <ListingCover listing={listing} priority="high" />
          </View>
        )}

        <View style={styles.body}>
          <View style={styles.header}>
            <ListingIcon listing={listing} size={64} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.title, { color: theme.label }]}>{listing.title}</Text>
              <Pressable
                accessibilityRole="link"
                onPress={() => router.push(`/builder/${listing.builder.handle}`)}
                hitSlop={8}
              >
                <Text style={{ color: theme.tint, fontSize: 15 }}>@{listing.builder.handle}</Text>
              </Pressable>
            </View>
            <HeartButton
              productId={listing.id}
              title={listing.title}
              saved={listing.saved}
              rank={rank}
              tone="plain"
            />
          </View>

          {listing.hook ? (
            <Text style={[styles.hook, { color: theme.label }]}>{listing.hook}</Text>
          ) : null}

          <View style={styles.facts}>
            {facts.map((fact) => (
              <Text
                key={fact}
                style={[styles.fact, { backgroundColor: theme.fill, color: theme.secondaryLabel }]}
              >
                {fact}
              </Text>
            ))}
            {listing.rating !== null ? (
              <Text style={[styles.fact, { backgroundColor: theme.fill, color: theme.label }]}>
                ★ {listing.rating.toFixed(1)}
                {listing.ratingCount ? ` · ${formatCount(listing.ratingCount)} ratings` : ""}
              </Text>
            ) : null}
          </View>

          {listing.description ? (
            <Pressable onPress={() => setExpanded((value) => !value)} accessibilityRole="button">
              <Text
                numberOfLines={expanded ? undefined : 4}
                style={[styles.description, { color: theme.label }]}
              >
                {listing.description}
              </Text>
              {!expanded ? <Text style={{ color: theme.tint, marginTop: 4 }}>More</Text> : null}
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/builder/${listing.builder.handle}`)}
            style={[styles.builder, { backgroundColor: theme.card }]}
          >
            <View style={[styles.avatar, { backgroundColor: theme.fill }]}>
              <Text style={{ color: theme.label, fontWeight: "600", fontSize: 18 }}>
                {listing.builder.displayName.slice(0, 1).toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.label, fontWeight: "600", fontSize: 16 }}>
                {listing.builder.displayName}
                {listing.unverified ? (
                  <Text style={{ color: theme.warning, fontWeight: "400", fontSize: 13 }}>
                    {"  "}Unverified
                  </Text>
                ) : null}
              </Text>
              <Text numberOfLines={1} style={{ color: theme.secondaryLabel }}>
                {listing.builder.bio ??
                  `${listing.builder.listingCount} product${listing.builder.listingCount === 1 ? "" : "s"}`}
              </Text>
            </View>
            <Icon name="chevron.right" size={14} color={theme.tertiaryLabel} />
          </Pressable>

          {link ? (
            <Button
              title={listing.source === "app_store" ? "View on the App Store" : "Visit the website"}
              kind="plain"
              onPress={() => void WebBrowser.openBrowserAsync(link)}
            />
          ) : null}
        </View>
      </ScrollView>

      <View
        style={[
          styles.bar,
          {
            paddingBottom: insets.bottom + SPACING.sm,
            backgroundColor: theme.background,
            borderTopColor: theme.separator,
          },
        ]}
      >
        <Button title="Send a proposal" onPress={propose} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  shot: { borderRadius: 24 },
  coverFrame: { height: 320, borderRadius: 28, overflow: "hidden", marginTop: SPACING.md },
  body: { padding: SPACING.lg, gap: SPACING.lg },
  header: { flexDirection: "row", alignItems: "center", gap: SPACING.md },
  title: { fontSize: 24, fontWeight: "700", letterSpacing: -0.3 },
  hook: { fontSize: 18, lineHeight: 24 },
  facts: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm },
  fact: {
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: "hidden",
  },
  description: { fontSize: 15, lineHeight: 22 },
  builder: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.md,
    padding: SPACING.md,
    borderRadius: 20,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
})
