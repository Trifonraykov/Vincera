import { SOCIAL_PROVIDER_META } from "@/lib/social/catalog"

import type { ParsedNotification } from "./types"

/**
 * What the notifications center says for each notification: a one-line title and an optional
 * detail line, from the stored payload only (names and titles, never message bodies). Client-safe.
 * A new type needs a case here; the `never` check below fails the typecheck until it has one.
 */

export type NotificationTone = "account" | "proposal" | "collab" | "task"

export type NotificationText = { title: string; detail: string | null; tone: NotificationTone }

const quoted = (title: string) => `“${title}”`

export function describeNotification(notification: ParsedNotification): NotificationText {
  switch (notification.type) {
    case "social.expired": {
      const label = SOCIAL_PROVIDER_META[notification.payload.provider].label
      return {
        title: `Reconnect your ${label} account`,
        detail: "We couldn't refresh its stats because access expired.",
        tone: "account",
      }
    }
    case "payouts.ready":
      return {
        title: "Your payouts are set up",
        detail: "You can sign agreements and get paid for sales.",
        tone: "account",
      }
    case "proposal.received":
      return {
        title: `${notification.payload.counterpart_name} sent you a proposal`,
        detail: `About ${quoted(notification.payload.target_title)}`,
        tone: "proposal",
      }
    case "proposal.countered":
      return {
        title: `${notification.payload.counterpart_name} countered your proposal`,
        detail: `New terms for ${quoted(notification.payload.target_title)}. It's your turn.`,
        tone: "proposal",
      }
    case "proposal.accepted":
      return {
        title: `${notification.payload.counterpart_name} accepted your proposal`,
        detail: `You're collaborating on ${quoted(notification.payload.target_title)}.`,
        tone: "proposal",
      }
    case "proposal.declined":
      return {
        title: `${notification.payload.counterpart_name} declined your proposal`,
        detail: `About ${quoted(notification.payload.target_title)}`,
        tone: "proposal",
      }
    case "proposal.withdrawn":
      return {
        title: `${notification.payload.counterpart_name} withdrew their proposal`,
        detail: `About ${quoted(notification.payload.target_title)}`,
        tone: "proposal",
      }
    case "proposal.expired":
      return {
        title: `Your proposal with ${notification.payload.counterpart_name} expired`,
        detail: `About ${quoted(notification.payload.target_title)}, after 14 days without an answer.`,
        tone: "proposal",
      }
    case "agreement.ready":
      return {
        title: "Your agreement is ready to sign",
        detail: quoted(notification.payload.collab_title),
        tone: "collab",
      }
    case "agreement.signed":
      return {
        title: `${notification.payload.signer_name} signed the agreement`,
        detail: `${quoted(notification.payload.collab_title)}: your signature is next.`,
        tone: "collab",
      }
    case "agreement.completed":
      return {
        title: "The agreement is fully signed",
        detail: `${quoted(notification.payload.collab_title)}: time to build.`,
        tone: "collab",
      }
    case "agreement.reminder":
      return {
        title: "Sign your agreement",
        detail: `${quoted(notification.payload.collab_title)} has waited ${notification.payload.days_waiting} days.`,
        tone: "collab",
      }
    case "collab.stalled":
      return {
        title: `${quoted(notification.payload.collab_title)} has gone quiet`,
        detail: `No activity for ${notification.payload.idle_days} days.`,
        tone: "collab",
      }
    case "task.assigned":
      return {
        title: `${notification.payload.assigned_by_name} assigned you a task`,
        detail: `${quoted(notification.payload.task_title)} in ${quoted(notification.payload.collab_title)}`,
        tone: "task",
      }
    default: {
      const unhandled: never = notification
      return unhandled
    }
  }
}
