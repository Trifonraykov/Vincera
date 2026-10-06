import { CircleCheck, Clock, Handshake, Lightbulb, MessagesSquare, Package } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { AppBarSlot } from "@/components/layout/app-bar-slot"
import { ThreadPanel } from "@/components/messages/thread-panel"
import { ProposalActions } from "@/components/proposals/proposal-actions"
import { ProposalStatusBadge, YourTurnBadge } from "@/components/proposals/status-badge"
import { RevisionHistory, TermsList } from "@/components/proposals/terms"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { canViewProposal, canViewThread } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import { formatExact, formatTimeLeft } from "@/lib/proposals/display"
import { loadProposalDetail } from "@/lib/proposals/queries"
import { awaitingPartyId, otherPartyId, proposalActionsFor } from "@/lib/proposals/state"
import { loadThreadAccess } from "@/lib/threads/access"

export const metadata: Metadata = { title: "Proposal" }

type Props = {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const CLOSED_COPY = {
  declined: "This proposal was declined.",
  expired: "This proposal expired after 14 days without an answer.",
  withdrawn: "This proposal was withdrawn.",
} as const

/**
 * One proposal (§12 `/app/proposals/[id]`): the offer on the table with whose turn it is, the
 * viewer's actions per the state machine (accept / counter / decline, or withdraw), every
 * revision with what changed highlighted, and the proposal's message thread. Only its two parties
 * and admins (read-only) may see it (`canViewProposal`); anyone else gets a 404.
 */
export default async function ProposalPage({ params, searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  const detail = await loadProposalDetail(db, id)
  if (!detail || !canViewProposal(user, detail.access)) notFound()

  const at = now()
  const current = detail.revisions.find((revision) => revision.id === detail.currentRevisionId)
  if (!current) notFound()
  const isParty = detail.fromUserId === user.id || detail.toUserId === user.id
  const counterpartId = isParty
    ? otherPartyId(detail, user.id)
    : (awaitingPartyId(detail.access) ?? detail.toUserId)
  const counterpart = detail.parties.get(counterpartId)
  const counterpartName = counterpart?.name ?? "the other party"
  // Past its expiry but not swept yet by the hourly job: shown, and answered, as expired.
  const lapsed = detail.closedAt === null && detail.expiresAt.getTime() <= at.getTime()
  const status = lapsed ? "expired" : detail.status
  const awaiting = lapsed ? null : awaitingPartyId(detail.access)
  const yourTurn = awaiting === user.id
  const actions = lapsed ? [] : proposalActionsFor(user, detail.access)
  const thread = detail.threadId ? await loadThreadAccess(db, detail.threadId) : null
  const showThread = thread !== null && canViewThread(user, thread)
  const sent = (await searchParams).sent === "1" && detail.fromUserId === user.id
  const KindIcon = detail.target.kind === "idea" ? Lightbulb : Package

  const terms = {
    creatorSplitPct: current.creatorSplitPct,
    builderSplitPct: current.builderSplitPct,
    timelineWeeks: current.timelineWeeks,
    scope: current.scope,
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <AppBarSlot title="Proposal" back="/app/proposals" />
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <KindIcon className="size-4" aria-hidden="true" />
          {detail.target.kind === "idea" ? "Idea" : "Product"}
          {isParty ? (
            <>
              {" · "}
              {detail.fromUserId === user.id ? "You sent this to" : "Sent to you by"}{" "}
              {counterpartName}
              {counterpart ? ` (${counterpart.role})` : null}
            </>
          ) : null}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          {detail.target.title}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <ProposalStatusBadge status={status} />
          {yourTurn ? <YourTurnBadge /> : null}
        </div>
      </div>

      {sent ? (
        <Alert>
          <CircleCheck aria-hidden="true" />
          <AlertTitle>Proposal sent</AlertTitle>
          <AlertDescription>
            {counterpartName} has 14 days to accept, counter or decline. We&apos;ll let you know.
          </AlertDescription>
        </Alert>
      ) : null}

      {detail.status === "accepted" ? (
        <Alert>
          <Handshake aria-hidden="true" />
          <AlertTitle>Accepted: you&apos;re collaborating</AlertTitle>
          <AlertDescription>
            <p>Next, you both sign the agreement with these terms.</p>
            {detail.collabId && isParty ? (
              <Button asChild size="sm" className="mt-2 h-11 sm:h-8">
                <Link href={`/app/collabs/${detail.collabId}`}>Open the collab</Link>
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : status in CLOSED_COPY ? (
        <Alert>
          <Clock aria-hidden="true" />
          <AlertTitle>Closed</AlertTitle>
          <AlertDescription>{CLOSED_COPY[status as keyof typeof CLOSED_COPY]}</AlertDescription>
        </Alert>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="size-4 shrink-0" aria-hidden="true" />
          <span>
            {yourTurn
              ? `Your turn: accept, counter or decline. Expires ${formatTimeLeft(detail.expiresAt, at)}`
              : isParty
                ? `Waiting for ${counterpartName} to answer. Expires ${formatTimeLeft(detail.expiresAt, at)}`
                : `Open. Expires ${formatTimeLeft(detail.expiresAt, at)}`}{" "}
            <time dateTime={detail.expiresAt.toISOString()} className="whitespace-nowrap">
              ({formatExact(detail.expiresAt)}).
            </time>
          </span>
        </p>
      )}

      <section
        aria-labelledby="terms-heading"
        className="space-y-4 rounded-xl border bg-card p-4 shadow-xs"
      >
        <h2 id="terms-heading" className="font-semibold">
          {detail.status === "accepted" ? "Agreed terms" : "Terms on the table"}
        </h2>
        <TermsList terms={current} />
        <ProposalActions
          layout="inline"
          className="hidden sm:flex"
          proposalId={detail.id}
          revisionId={current.id}
          actions={actions}
          terms={terms}
          counterpartName={counterpartName}
        />
      </section>

      {showThread && thread ? (
        <section
          id="messages"
          aria-labelledby="messages-heading"
          className="scroll-mt-20 space-y-3"
        >
          <h2 id="messages-heading" className="flex items-center gap-2 font-semibold">
            <MessagesSquare className="size-4 text-muted-foreground" aria-hidden="true" />
            Messages
          </h2>
          <ThreadPanel
            db={db}
            thread={thread}
            viewer={user}
            closedNote={
              detail.status === "accepted"
                ? "This proposal was accepted: carry on in the collab's messages."
                : "This proposal is closed, so its conversation is read-only."
            }
          />
        </section>
      ) : null}

      <section aria-labelledby="history-heading" className="space-y-3">
        <h2 id="history-heading" className="font-semibold">
          History
        </h2>
        <RevisionHistory
          revisions={detail.revisions}
          parties={detail.parties}
          viewerId={user.id}
          now={at}
        />
      </section>

      {/* Phones: the same actions in the sticky bar above the tab bar (a direct child of the
          page, so it sticks while the whole page scrolls). */}
      <ProposalActions
        layout="sticky"
        className="sm:hidden"
        proposalId={detail.id}
        revisionId={current.id}
        actions={actions}
        terms={terms}
        counterpartName={counterpartName}
      />
    </div>
  )
}
