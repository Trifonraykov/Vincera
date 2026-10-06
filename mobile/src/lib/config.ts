import * as SecureStore from "expo-secure-store"
import { Platform } from "react-native"

/**
 * Where the app finds the Vincera backend. `EXPO_PUBLIC_API_URL` (inlined at build time,
 * mobile/README.md) is the default; the sign-in screen lets a person point the app at another
 * server (e.g. a tunnel to the desktop app), remembered on the device. The default suits the iOS
 * Simulator on the Mac that runs `pnpm dev`, because the Simulator shares the Mac's localhost.
 */
export const DEFAULT_API_URL = normalizeServerUrl(
  process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000",
)

const KEY = "vincera.server"
let current = DEFAULT_API_URL

/** "my-tunnel.example" → "https://my-tunnel.example"; trailing slashes and paths dropped. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim()
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    return `${url.protocol}//${url.host}`
  } catch {
    return trimmed.replace(/\/+$/, "")
  }
}

export function getApiUrl(): string {
  return current
}

/** The dev mailbox, where sign-in codes land when email is faked (§19.3). */
export function devMailboxUrl(): string {
  return `${current}/api/dev/mailbox`
}

/** Read the remembered server at launch (before the first API call). */
export async function loadApiUrl(): Promise<string> {
  try {
    const stored =
      Platform.OS === "web"
        ? (globalThis.localStorage?.getItem(KEY) ?? null)
        : await SecureStore.getItemAsync(KEY)
    if (stored) current = normalizeServerUrl(stored)
  } catch {
    // Keep the default.
  }
  return current
}

export async function saveApiUrl(input: string): Promise<string> {
  current = normalizeServerUrl(input) || DEFAULT_API_URL
  try {
    if (Platform.OS === "web") globalThis.localStorage?.setItem(KEY, current)
    else await SecureStore.setItemAsync(KEY, current)
  } catch {
    // Kept for this run only.
  }
  return current
}
