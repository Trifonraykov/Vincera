import * as Haptics from "expo-haptics"
import { Platform } from "react-native"

/** Taptic feedback for actions that change something. No-ops where there is no Taptic Engine. */

export function tapLight(): void {
  if (Platform.OS === "web") return
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)
}

export function selectionTick(): void {
  if (Platform.OS === "web") return
  void Haptics.selectionAsync().catch(() => undefined)
}

export function notifySuccess(): void {
  if (Platform.OS === "web") return
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
}

export function notifyError(): void {
  if (Platform.OS === "web") return
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined)
}
