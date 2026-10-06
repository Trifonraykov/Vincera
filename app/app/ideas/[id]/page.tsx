import { CheckCircle2, Send } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { IdeaDetails } from "@/components/ideas/idea-details"
import { IdeaForm } from "@/components/ideas/idea-form"
import { AppBarSlot } from "@/components/layout/app-bar-slot"
import { PageHeader } from "@/components/shared/page-header"
import { ArchiveButton, RestoreButton } from "@/components/supply/status-actions"
import { SupplyStatusPanel } from "@/components/supply/status-panel"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { canManageIdea, canViewIdea, hasRole } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { findIdea } from "@/lib/ideas/queries"
import { formatMoneyInput } from "@/lib/money-input"
import { isBuiltRoute } from "@/lib/nav"
import { ownerActions } from "@/lib/supply/lifecycle"

export const metadata: Metadata = { title: "Idea" }

type Props = {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** The confirmation after a create, while the status it describes still holds. */
const SAVED_NOTICES: Record<string, { status: string; text: string }> = {
  created: { status: "draft", text: "Saved as a draft. Only you can see it until you publish it." },
  published: {
    status: "open",
    text: "Published. Builders can find your idea and send you proposals.",
  },
}

/**
 * `/app/ideas/[id]` (§12). The owner edits it here while it is a draft or open (the form, with
 * Publish on drafts), archives it, or restores an archived one; in a collab or launched it is
 * read-only (lib/supply/lifecycle.ts). Other signed-in users see published ideas only
 * (`canViewIdea`); anything else is a 404, so drafts don't leak.
 */
export default async function IdeaPage({ params, searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const idea = await findIdea(getDb(), id)
  if (!idea) notFound()
  const access = { ownerUserId: idea.owner.userId, status: idea.status }
  if (!canViewIdea(user, access)) notFound()

  const isOwner = canManageIdea(user, access)
  const actions = isOwner ? ownerActions("idea", idea.status) : []
  const saved = (await searchParams).saved
  const savedNotice = isOwner && typeof saved === "string" ? SAVED_NOTICES[saved] : undefined
  const notice = savedNotice?.status === idea.status ? savedNotice.text : undefined
  const canPropose =
    !isOwner && idea.status === "open" && hasRole(user, "builder") && isBuiltRoute("/app/proposals")

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <AppBarSlot
        title={idea.title}
        back={
          isOwner
            ? "/app/ideas"
            : isBuiltRoute("/app/discover/briefs")
              ? "/app/discover/briefs"
              : "/app"
        }
      />
      <PageHeader
        title={idea.title}
        description={isOwner ? "Your idea" : `An idea by @${idea.owner.handle}`}
      />

      {notice ? (
        <Alert>
          <CheckCircle2 aria-hidden="true" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {isOwner ? (
        <SupplyStatusPanel kind="idea" status={idea.status}>
          {actions.includes("archive") ? (
            <ArchiveButton kind="idea" id={idea.id} title={idea.title} />
          ) : null}
          {actions.includes("restore") ? <RestoreButton kind="idea" id={idea.id} /> : null}
        </SupplyStatusPanel>
      ) : null}

      {actions.includes("edit") ? (
        <IdeaForm
          mode="edit"
          ideaId={idea.id}
          status={idea.status}
          defaults={{
            title: idea.title,
            problem: idea.problem ?? "",
            audienceEvidence: idea.audienceEvidence ?? "",
            format: idea.format,
            targetPrice: formatMoneyInput(idea.targetPriceCents, idea.currency),
            topics: idea.topics,
          }}
        />
      ) : (
        <IdeaDetails idea={idea} showOwner={!isOwner} />
      )}

      {canPropose ? (
        <div className="flex justify-end">
          <Button asChild className="w-full sm:w-auto">
            <Link href={`/app/proposals/new?to=${idea.owner.userId}&idea=${idea.id}`}>
              <Send aria-hidden="true" />
              Send a proposal
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  )
}
