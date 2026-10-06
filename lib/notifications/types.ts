import { z } from "zod"

import { SOCIAL_PROVIDER_IDS } from "@/lib/social/types"

/**
 * Notification catalog (§5 `notifications`, §7.4): every notification type and its payload.
 * Client-safe, so the in-app list and the settings page share it.
 *
 * `type` is also the key of `notification_prefs` (per-type email / in-app switches). Payloads hold
 * what the in-app list needs to render and link: ids, enums and short display values (names and
 * titles are fine here, unlike event properties). Never tokens, emails or message bodies.
 *
 * Phase 2–3 types were declared by the W2 prep (CLAUDE.md §19.24); the area that sends each one is
 * noted next to it. Adding a type: a schema here, its label, its link and its group.
 */

const id = z.uuid()
/** A person's display name (profile display name, else account name). */
const name = z.string().trim().min(1).max(120)
/** An idea, product, collab or task title. */
const title = z.string().trim().min(1).max(200)

/** What a proposal notification shows: the other party and what the proposal is about. */
const proposalPayload = z.object({
  proposal_id: id,
  /** The other party, from the recipient's point of view. */
  counterpart_name: name,
  target_kind: z.enum(["idea", "product"]),
  target_title: title,
})

const agreementPayload = z.object({ collab_id: id, agreement_id: id, collab_title: title })

export const NOTIFICATION_PAYLOAD_SCHEMAS = {
  // --- Phase 1 ---------------------------------------------------------------------------------
  /** A social connection's token expired or was revoked (§7.1); the user should reconnect it. */
  "social.expired": z.object({ connection_id: id, provider: z.enum(SOCIAL_PROVIDER_IDS) }),
  /** Stripe enabled payouts for the user's connected account (§7.2, §19.10). */
  /** `stripe_account_id` is Stripe's connected account id (`acct_…`), not our row id. */
  "payouts.ready": z.object({ stripe_account_id: z.string().regex(/^acct_[A-Za-z0-9_]+$/) }),

  // --- Phase 3: proposals (sent by lib/proposals) ---------------------------------------------
  /** To the recipient of a new proposal. Email: proposal-received.tsx. */
  "proposal.received": proposalPayload,
  /** To the party who must answer a counter-offer. Email: proposal-countered.tsx. */
  "proposal.countered": proposalPayload.extend({ revision_number: z.int().min(2) }),
  /** To the party whose offer was accepted. Email: proposal-accepted.tsx. */
  "proposal.accepted": proposalPayload.extend({ collab_id: id }),
  /** To the party whose offer was declined. Email: notification.tsx. */
  "proposal.declined": proposalPayload,
  /** To the party awaiting an answer when the other side withdrew. Email: notification.tsx. */
  "proposal.withdrawn": proposalPayload,
  /** To both parties when an open proposal passed `expires_at`. Email: notification.tsx. */
  "proposal.expired": proposalPayload,

  // --- Phase 3: collabs and agreements (sent by lib/collabs, lib/agreements, lib/tasks) --------
  /** To both members when the agreement is generated. Email: agreement-ready.tsx. */
  "agreement.ready": agreementPayload,
  /** To the member who has not signed yet, when the other one signed. Email: notification.tsx. */
  "agreement.signed": agreementPayload.extend({ signer_name: name }),
  /** To both members once both signed (PDF attached). Email: agreement-completed.tsx. */
  "agreement.completed": agreementPayload,
  /** reminders/stalled: a member still has not signed 3 days after generation. */
  "agreement.reminder": agreementPayload.extend({ days_waiting: z.int().min(1) }),
  /** reminders/stalled: no member activity for 7 days (to both members). */
  "collab.stalled": z.object({ collab_id: id, collab_title: title, idle_days: z.int().min(1) }),
  /** To the assignee when the other member assigns them a task (in-app; email optional). */
  "task.assigned": z.object({
    collab_id: id,
    task_id: id,
    task_title: title,
    collab_title: title,
    assigned_by_name: name,
  }),
} as const satisfies Record<string, z.ZodObject>

type PayloadSchemas = typeof NOTIFICATION_PAYLOAD_SCHEMAS

export type NotificationType = keyof PayloadSchemas
export type NotificationPayloadOf<T extends NotificationType> = z.output<PayloadSchemas[T]>

/** Notification type → payload, for code that prefers the interface view. */
export type NotificationCatalog = { [T in NotificationType]: NotificationPayloadOf<T> }

export const NOTIFICATION_TYPES = [
  "social.expired",
  "payouts.ready",
  "proposal.received",
  "proposal.countered",
  "proposal.accepted",
  "proposal.declined",
  "proposal.withdrawn",
  "proposal.expired",
  "agreement.ready",
  "agreement.signed",
  "agreement.completed",
  "agreement.reminder",
  "collab.stalled",
  "task.assigned",
] as const satisfies readonly NotificationType[]

// Compile-time check that NOTIFICATION_TYPES lists every catalog entry.
type MissingNotificationTypes = Exclude<NotificationType, (typeof NOTIFICATION_TYPES)[number]>
const _allNotificationTypesListed: [MissingNotificationTypes] extends [never]
  ? true
  : MissingNotificationTypes = true

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value)
}

/**
 * Types whose email is always sent (`notify` with `email.required`): legal or transactional
 * records. Settings → Notifications shows their email switch as always on (CLAUDE.md §19.30).
 */
export const REQUIRED_EMAIL_TYPES: readonly NotificationType[] = ["agreement.completed"]

/** Labels for /app/settings/notifications (unique: the settings rows are named by them). */
export const NOTIFICATION_TYPE_LABELS = {
  "social.expired": "A connected account needs to be reconnected",
  "payouts.ready": "Your payouts are set up",
  "proposal.received": "Someone sends you a proposal",
  "proposal.countered": "Someone counters your proposal",
  "proposal.accepted": "Your proposal is accepted",
  "proposal.declined": "Your proposal is declined",
  "proposal.withdrawn": "A proposal to you is withdrawn",
  "proposal.expired": "A proposal expires without an answer",
  "agreement.ready": "An agreement is ready to sign",
  "agreement.signed": "Your collaborator signs the agreement",
  "agreement.completed": "An agreement is fully signed",
  "agreement.reminder": "Reminders to sign an agreement",
  "collab.stalled": "Reminders when a collab goes quiet",
  "task.assigned": "Someone assigns you a task",
} as const satisfies Record<NotificationType, string>

/** Sections of the settings page, in order; every type is in exactly one. */
export const NOTIFICATION_GROUPS = [
  { label: "Account", types: ["social.expired", "payouts.ready"] },
  {
    label: "Proposals",
    types: [
      "proposal.received",
      "proposal.countered",
      "proposal.accepted",
      "proposal.declined",
      "proposal.withdrawn",
      "proposal.expired",
    ],
  },
  {
    label: "Collabs",
    types: [
      "agreement.ready",
      "agreement.signed",
      "agreement.completed",
      "agreement.reminder",
      "collab.stalled",
      "task.assigned",
    ],
  },
] as const satisfies readonly { label: string; types: readonly NotificationType[] }[]

/** Where a notification of each type leads in the app. */
export const NOTIFICATION_LINKS: {
  [T in NotificationType]: (payload: NotificationPayloadOf<T>) => string
} = {
  "social.expired": () => "/app/settings/connections",
  "payouts.ready": () => "/app/settings/payouts",
  "proposal.received": (p) => `/app/proposals/${p.proposal_id}`,
  "proposal.countered": (p) => `/app/proposals/${p.proposal_id}`,
  "proposal.accepted": (p) => `/app/collabs/${p.collab_id}`,
  "proposal.declined": (p) => `/app/proposals/${p.proposal_id}`,
  "proposal.withdrawn": (p) => `/app/proposals/${p.proposal_id}`,
  "proposal.expired": (p) => `/app/proposals/${p.proposal_id}`,
  "agreement.ready": (p) => `/app/collabs/${p.collab_id}/agreement`,
  "agreement.signed": (p) => `/app/collabs/${p.collab_id}/agreement`,
  "agreement.completed": (p) => `/app/collabs/${p.collab_id}/agreement`,
  "agreement.reminder": (p) => `/app/collabs/${p.collab_id}/agreement`,
  "collab.stalled": (p) => `/app/collabs/${p.collab_id}`,
  "task.assigned": (p) => `/app/collabs/${p.collab_id}/tasks`,
}

/** A stored notification whose type is known and whose payload parses. */
export type ParsedNotification = {
  [T in NotificationType]: { type: T; payload: NotificationPayloadOf<T> }
}[NotificationType]

/**
 * Parse a stored row's `type` and `payload` (jsonb, unchecked by the database). Null for unknown
 * types (e.g. one removed later) or malformed payloads: lists should skip those rows.
 */
export function parseNotification(type: string, payload: unknown): ParsedNotification | null {
  if (!isNotificationType(type)) return null
  const parsed = NOTIFICATION_PAYLOAD_SCHEMAS[type].safeParse(payload)
  if (!parsed.success) return null
  // The schema for `type` produced the payload, so the pair is consistent.
  return { type, payload: parsed.data } as ParsedNotification
}

/** The app path a stored notification links to, or null when it cannot be parsed. */
export function notificationHref(type: string, payload: unknown): string | null {
  const notification = parseNotification(type, payload)
  if (!notification) return null
  const link = NOTIFICATION_LINKS[notification.type] as (payload: unknown) => string
  return link(notification.payload)
}
