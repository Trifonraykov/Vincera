import "server-only"

import { createElement } from "react"

import type { Tx } from "@/lib/db/client"
import { env } from "@/lib/env"
import NotificationEmail from "@/lib/email/templates/notification"
import ProposalAcceptedEmail, {
  proposalAcceptedSubject,
} from "@/lib/email/templates/proposal-accepted"
import ProposalCounteredEmail, {
  proposalCounteredSubject,
} from "@/lib/email/templates/proposal-countered"
import ProposalReceivedEmail, {
  proposalReceivedSubject,
} from "@/lib/email/templates/proposal-received"
import { notify } from "@/lib/notifications/notify"
import { absoluteUrl } from "@/lib/urls"

import { clip } from "./queries"

/**
 * The proposal notifications (CLAUDE.md §19.24 table): in-app plus email, each switchable per
 * type in Settings → Notifications. Received, countered and accepted have their own templates
 * (§7.4); declined, withdrawn and expired use the generic one. Every call passes a dedupe key, so
 * a retried transition or job never notifies twice. Call them last in the transition's
 * transaction (`notify` sends the email right away).
 */

type ProposalNotice = {
  proposalId: string
  /** Who gets the notification. */
  recipientUserId: string
  /** The other party, from the recipient's point of view. */
  counterpartName: string
  target: { kind: "idea" | "product"; title: string; ownerUserId: string }
}

type Terms = { creatorSplitPct: number; builderSplitPct: number; timelineWeeks: number }

const NAME_MAX = 120
const TITLE_MAX = 200

function payloadOf(notice: ProposalNotice) {
  return {
    proposal_id: notice.proposalId,
    counterpart_name: clip(notice.counterpartName, NAME_MAX),
    target_kind: notice.target.kind,
    target_title: clip(notice.target.title, TITLE_MAX),
  }
}

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" })

function proposalUrl(proposalId: string): string {
  return absoluteUrl(`/app/proposals/${proposalId}`)
}

export async function notifyProposalReceived(
  tx: Tx,
  notice: ProposalNotice,
  details: { terms: Terms; expiresAt: Date },
): Promise<void> {
  const payload = payloadOf(notice)
  await notify(
    {
      userId: notice.recipientUserId,
      type: "proposal.received",
      payload,
      dedupeKey: `proposal.received:${notice.proposalId}`,
      email: {
        subject: proposalReceivedSubject(payload.counterpart_name),
        react: createElement(ProposalReceivedEmail, {
          appName: env.APP_NAME,
          senderName: payload.counterpart_name,
          targetKind: notice.target.kind,
          ownership: notice.target.ownerUserId === notice.recipientUserId ? "yours" : "theirs",
          targetTitle: payload.target_title,
          terms: details.terms,
          proposalUrl: proposalUrl(notice.proposalId),
          expiresOn: dateFormat.format(details.expiresAt),
        }),
      },
    },
    tx,
  )
}

export async function notifyProposalCountered(
  tx: Tx,
  notice: ProposalNotice,
  details: { terms: Terms; revisionNumber: number; expiresAt: Date },
): Promise<void> {
  const payload = payloadOf(notice)
  await notify(
    {
      userId: notice.recipientUserId,
      type: "proposal.countered",
      payload: { ...payload, revision_number: details.revisionNumber },
      dedupeKey: `proposal.countered:${notice.proposalId}:${details.revisionNumber}`,
      email: {
        subject: proposalCounteredSubject(payload.counterpart_name),
        react: createElement(ProposalCounteredEmail, {
          appName: env.APP_NAME,
          counterpartName: payload.counterpart_name,
          targetTitle: payload.target_title,
          terms: details.terms,
          proposalUrl: proposalUrl(notice.proposalId),
          expiresOn: dateFormat.format(details.expiresAt),
        }),
      },
    },
    tx,
  )
}

export async function notifyProposalAccepted(
  tx: Tx,
  notice: ProposalNotice,
  details: { terms: Terms; collabId: string },
): Promise<void> {
  const payload = payloadOf(notice)
  await notify(
    {
      userId: notice.recipientUserId,
      type: "proposal.accepted",
      payload: { ...payload, collab_id: details.collabId },
      dedupeKey: `proposal.accepted:${notice.proposalId}`,
      email: {
        subject: proposalAcceptedSubject(payload.counterpart_name),
        react: createElement(ProposalAcceptedEmail, {
          appName: env.APP_NAME,
          counterpartName: payload.counterpart_name,
          targetTitle: payload.target_title,
          terms: details.terms,
          collabUrl: absoluteUrl(`/app/collabs/${details.collabId}`),
        }),
      },
    },
    tx,
  )
}

/** Declined, withdrawn or expired: the generic notification email. */
export async function notifyProposalClosed(
  tx: Tx,
  type: "proposal.declined" | "proposal.withdrawn" | "proposal.expired",
  notice: ProposalNotice,
): Promise<void> {
  const payload = payloadOf(notice)
  const name = payload.counterpart_name
  const title = payload.target_title
  const copy = {
    "proposal.declined": {
      subject: `${name} declined your proposal`,
      heading: `${name} declined your proposal`,
      paragraphs: [
        `${name} decided not to go ahead with the proposal about “${title}”.`,
        "There are more people to work with: have a look at your matches.",
      ],
    },
    "proposal.withdrawn": {
      subject: `${name} withdrew their proposal`,
      heading: `${name} withdrew their proposal`,
      paragraphs: [
        `${name} withdrew the proposal about “${title}”, so there is nothing left to answer.`,
      ],
    },
    "proposal.expired": {
      subject: `A proposal about “${title}” expired`,
      heading: "A proposal expired",
      paragraphs: [
        `The proposal with ${name} about “${title}” expired after 14 days without an answer.`,
        "If you still want to work together, either of you can send a new one.",
      ],
    },
  }[type]
  await notify(
    {
      userId: notice.recipientUserId,
      type,
      payload,
      dedupeKey: `${type}:${notice.proposalId}`,
      email: {
        subject: copy.subject,
        react: createElement(NotificationEmail, {
          appName: env.APP_NAME,
          heading: copy.heading,
          paragraphs: copy.paragraphs,
          action: { label: "View the proposal", url: proposalUrl(notice.proposalId) },
        }),
      },
    },
    tx,
  )
}
