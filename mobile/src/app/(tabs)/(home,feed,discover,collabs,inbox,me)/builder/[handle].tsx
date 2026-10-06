import { builderProfileGridOutput, type ListingCardWire } from "@shared/schemas"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native"

import { BottomShade, ListingCover, ListingIcon } from "@/components/listing"
import { api } from "@/lib/api"
import { useApi } from "@/lib/use-api"
import { Loaded } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * A builder's profile as a grid of their listings (CLAUDE.md §19.45), two across: each tile the
 * listing's picture with its icon and name. A tile opens the listing.
 */
export default function BuilderScreen() {
  const { handle } = useLocalSearchParams<{ handle: string }>()
  const state = useApi(() => api(builderProfileGridOutput, "GET", `/builders/${handle}`), handle)
  const theme = useTheme()
  const { width } = useWindowDimensions()
  const tile = (width - SPACING.lg * 2 - SPACING.md) / 2

  return (
    <>
      <Stack.Screen options={{ title: state.data?.displayName ?? `@${handle}` }} />
      <Loaded state={state}>
        {(profile) => (
          <FlatList
            data={profile.listings}
            numColumns={2}
            keyExtractor={(item) => item.id}
            contentInsetAdjustmentBehavior="automatic"
            style={{ backgroundColor: theme.background }}
            contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md }}
            columnWrapperStyle={{ gap: SPACING.md }}
            ListHeaderComponent={
              <View style={styles.header}>
                <Text style={{ color: theme.secondaryLabel, fontSize: 15 }}>@{profile.handle}</Text>
                {profile.bio ? (
                  <Text style={{ color: theme.label, fontSize: 16, lineHeight: 22 }}>
                    {profile.bio}
                  </Text>
                ) : null}
                {profile.appStore ? (
                  <Text style={{ color: theme.secondaryLabel, fontSize: 13 }}>
                    {profile.appStore.developerName ?? "App Store developer"} ·{" "}
                    {profile.appStore.verified ? "verified" : "unverified"}
                  </Text>
                ) : null}
              </View>
            }
            ListEmptyComponent={
              <Text style={{ color: theme.secondaryLabel }}>No products listed yet.</Text>
            }
            renderItem={({ item }) => <Tile item={item} size={tile} />}
          />
        )}
      </Loaded>
    </>
  )
}

function Tile({ item, size }: { item: ListingCardWire; size: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      onPress={() => router.push(`/listing/${item.id}`)}
      style={({ pressed }) => [
        styles.tile,
        { width: size, height: size * 1.25 },
        pressed && { opacity: 0.85 },
      ]}
    >
      <ListingCover listing={item} />
      <BottomShade height="50%" />
      <View style={styles.tileInfo}>
        <ListingIcon listing={item} size={30} />
        <Text numberOfLines={2} style={styles.tileTitle}>
          {item.title}
        </Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  header: { gap: SPACING.sm, marginBottom: SPACING.sm },
  tile: { borderRadius: 22, overflow: "hidden", backgroundColor: "#1C1C1E" },
  tileInfo: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  tileTitle: { flex: 1, color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
})
