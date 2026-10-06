import { feedSaveOutput, type ListingCardWire } from "@shared/schemas"
import { Image } from "expo-image"
import { SymbolView } from "expo-symbols"
import { useState } from "react"
import { Alert, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native"

import { api, errorMessage } from "@/lib/api"
import { notifyError, tapLight } from "@/lib/haptics"

/**
 * Listing visuals for the feed, the listing screen and builder grids (CLAUDE.md §19.45), drawn
 * like the web's: the picture fills the frame (a tall screenshot from the top, a wide link preview
 * over a blurred copy of itself), else the listing's generated gradient with its icon or initials.
 */

type Visual = ListingCardWire["visual"]

/** The generated gradient (native: CSS gradient support in RN; web preview: its first colour). */
export function gradientStyle(visual: Visual): ViewStyle {
  return Platform.OS === "web"
    ? { backgroundColor: visual.from }
    : ({ backgroundColor: visual.from, experimental_backgroundImage: visual.gradient } as ViewStyle)
}

export function ListingCover({
  listing,
  priority = "normal",
}: {
  listing: Pick<ListingCardWire, "cover" | "icon" | "visual">
  priority?: "high" | "normal"
}) {
  const { cover, icon, visual } = listing
  if (cover) {
    const wide = cover.width !== null && cover.height !== null && cover.width > cover.height
    if (!wide) {
      return (
        <Image
          source={cover.url}
          style={[StyleSheet.absoluteFill, { backgroundColor: visual.from }]}
          contentFit="cover"
          contentPosition="top"
          transition={200}
          priority={priority}
          accessibilityIgnoresInvertColors
        />
      )
    }
    return (
      <View style={[StyleSheet.absoluteFill, gradientStyle(visual)]}>
        <Image
          source={cover.url}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          blurRadius={40}
          priority={priority}
        />
        <Image
          source={cover.url}
          style={styles.wide}
          contentFit="contain"
          transition={200}
          priority={priority}
        />
      </View>
    )
  }
  return (
    <View style={[StyleSheet.absoluteFill, styles.center, gradientStyle(visual)]}>
      {icon ? (
        <Image source={icon.url} style={styles.bigIcon} transition={200} />
      ) : (
        <Text style={styles.initials}>{visual.initials}</Text>
      )}
    </View>
  )
}

export function ListingIcon({
  listing,
  size = 48,
}: {
  listing: Pick<ListingCardWire, "icon" | "visual">
  size?: number
}) {
  const radius = size * 0.24
  if (listing.icon) {
    return (
      <Image
        source={listing.icon.url}
        style={{ width: size, height: size, borderRadius: radius }}
        transition={150}
      />
    )
  }
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: radius },
        styles.center,
        gradientStyle(listing.visual),
      ]}
    >
      <Text style={{ color: "#FFFFFF", fontWeight: "600", fontSize: size * 0.34 }}>
        {listing.visual.initials}
      </Text>
    </View>
  )
}

/** Shade at the bottom of a card so white text reads on any picture. */
export function BottomShade({ height = "60%" }: { height?: ViewStyle["height"] }) {
  return (
    <View
      pointerEvents="none"
      style={[
        styles.shade,
        { height },
        Platform.OS === "web"
          ? { backgroundColor: "rgba(0,0,0,0.45)" }
          : ({
              experimental_backgroundImage:
                "linear-gradient(to top, rgba(0,0,0,0.88), rgba(0,0,0,0.45) 55%, rgba(0,0,0,0))",
            } as ViewStyle),
      ]}
    />
  )
}

/** The heart: save for later, with a Taptic tap. Optimistic; a refusal puts it back. */
export function HeartButton({
  productId,
  title,
  saved: initial,
  rank,
  tone = "overlay",
  onChange,
}: {
  productId: string
  title: string
  saved: boolean
  rank: number | null
  tone?: "overlay" | "plain"
  onChange?: (saved: boolean) => void
}) {
  const [saved, setSaved] = useState(initial)
  async function toggle() {
    const next = !saved
    setSaved(next)
    tapLight()
    try {
      await api(feedSaveOutput, "POST", `/feed/${productId}/${next ? "save" : "unsave"}`, { rank })
      onChange?.(next)
    } catch (error) {
      setSaved(!next)
      notifyError()
      Alert.alert("Couldn't save", errorMessage(error))
    }
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: saved }}
      accessibilityLabel={saved ? `Saved: ${title}. Remove from saved` : `Save ${title}`}
      hitSlop={8}
      onPress={() => void toggle()}
      style={({ pressed }) => [
        styles.heart,
        tone === "overlay" ? styles.heartOverlay : styles.heartPlain,
        pressed && { transform: [{ scale: 0.9 }] },
      ]}
    >
      <SymbolView
        name={saved ? "heart.fill" : "heart"}
        size={22}
        tintColor={saved ? "#FF2D55" : tone === "overlay" ? "#FFFFFF" : "#8E8E93"}
        animationSpec={saved ? { effect: { type: "bounce" } } : undefined}
        fallback={<Text style={{ color: saved ? "#FF2D55" : "#FFFFFF" }}>{saved ? "♥" : "♡"}</Text>}
      />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  wide: { position: "absolute", left: 16, right: 16, top: "14%", height: "52%", borderRadius: 18 },
  bigIcon: { width: 128, height: 128, borderRadius: 30, marginBottom: 64 },
  initials: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 72,
    fontWeight: "600",
    letterSpacing: -1,
    marginBottom: 64,
  },
  shade: { position: "absolute", left: 0, right: 0, bottom: 0 },
  heart: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  heartOverlay: { backgroundColor: "rgba(0,0,0,0.32)" },
  heartPlain: { backgroundColor: "rgba(120,120,128,0.16)" },
})
