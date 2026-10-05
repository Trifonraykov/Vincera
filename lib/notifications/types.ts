import type { SocialProvider } from "@/lib/db/schema"

/**
 * Notification catalog (§5 `notifications`, §7.4): every notification type and its payload.
 * Client-safe, so the in-app list and the settings page share it. Later phases add their types
 * here (proposal.received, agreement.ready, sale.made, ...).
 *
 * `type` is also the key of `notification_prefs` (per-type email / in-app switches). Payloads hold
 * what the in-app list needs to render and link: ids, enums and short display values. Never
 * tokens.
 */
export interface NotificationCatalog {
  /** A social connection's token expired or was revoked (§7.1); the user should reconnect it. */
  "social.expired": { connection_id: string; provider: SocialProvider }
  /** Stripe enabled payouts for the user's connected account (§7.2, §19.10). */
  "payouts.ready": { stripe_account_id: string }
}

export type NotificationType = keyof NotificationCatalog
export type NotificationPayloadOf<T extends NotificationType> = NotificationCatalog[T]

export const NOTIFICATION_TYPES = [
  "social.expired",
  "payouts.ready",
] as const satisfies readonly NotificationType[]

// Compile-time check that NOTIFICATION_TYPES lists every catalog entry.
type MissingNotificationTypes = Exclude<NotificationType, (typeof NOTIFICATION_TYPES)[number]>
const _allNotificationTypesListed: [MissingNotificationTypes] extends [never]
  ? true
  : MissingNotificationTypes = true

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value)
}

/** Labels for /app/settings/notifications. */
export const NOTIFICATION_TYPE_LABELS = {
  "social.expired": "A connected account needs to be reconnected",
  "payouts.ready": "Your payouts are set up",
} as const satisfies Record<NotificationType, string>

/** Where a notification of each type leads in the app. */
export const NOTIFICATION_LINKS = {
  "social.expired": "/app/settings/connections",
  "payouts.ready": "/app/settings/payouts",
} as const satisfies Record<NotificationType, string>
