import { useColorScheme } from "react-native"

/**
 * iOS system colours (UIKit's grouped-table palette) for light and dark mode. Plain values rather
 * than PlatformColor so the react-native-web preview renders the same.
 */
const LIGHT = {
  background: "#F2F2F7",
  card: "#FFFFFF",
  label: "#000000",
  secondaryLabel: "#6C6C70",
  tertiaryLabel: "#AEAEB2",
  separator: "#C6C6C8",
  fill: "#E5E5EA",
  tint: "#007AFF",
  destructive: "#FF3B30",
  success: "#34C759",
  warning: "#FF9500",
  tintSoft: "#E5F0FF",
}

const DARK: typeof LIGHT = {
  background: "#000000",
  card: "#1C1C1E",
  label: "#FFFFFF",
  secondaryLabel: "#98989F",
  tertiaryLabel: "#636366",
  separator: "#38383A",
  fill: "#2C2C2E",
  tint: "#0A84FF",
  destructive: "#FF453A",
  success: "#30D158",
  warning: "#FF9F0A",
  tintSoft: "#0A2540",
}

export type Theme = typeof LIGHT

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? DARK : LIGHT
}

export const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }
