import * as SecureStore from "expo-secure-store"
import { Platform } from "react-native"

/**
 * The bearer token lives in the iOS Keychain (expo-secure-store), readable only after the phone
 * has been unlocked once and never synced to other devices. The web build exists only for
 * previews and keeps it in localStorage.
 */

const KEY = "vincera.session"

export async function readToken(): Promise<string | null> {
  if (Platform.OS === "web") {
    try {
      return globalThis.localStorage?.getItem(KEY) ?? null
    } catch {
      return null
    }
  }
  return SecureStore.getItemAsync(KEY)
}

export async function writeToken(token: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      globalThis.localStorage?.setItem(KEY, token)
    } catch {
      // Private mode: the session lasts for this page only.
    }
    return
  }
  await SecureStore.setItemAsync(KEY, token, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  })
}

export async function clearToken(): Promise<void> {
  if (Platform.OS === "web") {
    try {
      globalThis.localStorage?.removeItem(KEY)
    } catch {
      // Nothing stored.
    }
    return
  }
  await SecureStore.deleteItemAsync(KEY)
}
