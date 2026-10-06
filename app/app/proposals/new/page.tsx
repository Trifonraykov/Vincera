import { CircleAlert, Lightbulb, Package, Send } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { AppBarSlot } from "@/components/layout/app-bar-slot"
import { ProposalForm } from "@/components/proposals/proposal-form"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  canManageOwnAccount,
  canSendProposal,
  canViewProposalTarget,
  hasRole,
} from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { isBuiltRoute } from "@/lib/nav"
import { DEFAULT_CREATOR_SPLIT_PCT, DEFAULT_TIMELINE_WEEKS } from "@/lib/proposals/fields"
import {
  findOpenProposalBetween,
  listOwnSendableTargets,
  loadPartyNames,
  loadRecipient,
} from "@/lib/proposals/queries"
import { loadSendContext } from "@/lib/proposals/service"
import { partyRole, sendBlockReason } from "@/lib/proposals/state"

export const metadata: Metadata = { title: "New proposal" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const uuid = z.uuid()
function idParam(value: string | string[] | undefined): string | null {
  const parsed = uuid.safeParse(Array.isArray(value) ? value[0] : value)
  return parsed.success ? parsed.data : null
}

function Header({ description }: { description?: string }) {
  return (
    <>
      <AppBarSlot title="New proposal" back="/app/proposals" />
      <PageHeader title="Send a proposal" description={description} />
    </>
  )
}

/**
 * New proposal (§12 `/app/proposals/new?to=<userId>&idea=<id>` or `&product=<id>`, plus `&match=`
 * from Discover). Blocked unless the sender finished onboarding (the /app gate, then
 * `canSendProposal`); the target must be open and belong to one of the two people, the recipient
 * active and onboarded. Without a target the sender picks one of their own open ideas or seeking
 * products. Sending redirects to the new proposal.
 */
export default async function NewProposalPage({ searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canManageOwnAccount(user))
  const params = await searchParams
  const to = idParam(params.to)
  const ideaId = idParam(params.idea)
  const productId = idParam(params.product)
  const matchId = idParam(params.match)
  const db = getDb()
  const discover = isBuiltRoute("/app/discover") ? "/app/discover" : null

  if (!to) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <Header />
        <EmptyState
          icon={Send}
          title="Choose who to send it to"
          description="Proposals start from someone's profile, idea or product. Find a match first, then send your proposal from there."
          action={
            discover ? (
              <Button asChild size="sm" className="h-11 sm:h-8">
                <Link href={discover}>Find people to work with</Link>
              </Button>
            ) : null
          }
        />
      </div>
    )
  }

  const recipient = await loadRecipient(db, to)
  if (!recipient) notFound()

  // No target yet: one of the sender's own open ideas (to a builder) or seeking products (to a creator).
  if (!ideaId && !productId) {
    const offerIdeas = hasRole(user, "creator") && hasRole(recipient, "builder")
    const offerProducts = hasRole(user, "builder") && hasRole(recipient, "creator")
    const targets = await listOwnSendableTargets(db, user.id, {
      ideas: offerIdeas,
      products: offerProducts,
    })
    const names = await loadPartyNames(db, [
      { userId: to, role: offerIdeas ? "builder" : "creator" },
    ])
    const name = names.get(to)?.name ?? "them"
    const newIdea = isBuiltRoute("/app/ideas") ? "/app/ideas/new" : null
    const newProduct = isBuiltRoute("/app/products") ? "/app/products/new" : null
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <Header description={`What would you like to work on with ${name}?`} />
        {targets.length === 0 ? (
          <EmptyState
            icon={offerIdeas ? Lightbulb : Package}
            title={
              offerIdeas || offerProducts
                ? "Nothing to offer yet"
                : "You can't offer them anything yourself"
            }
            description={
              offerIdeas || offerProducts
                ? `Publish ${offerIdeas ? "an idea" : "a product"} first, then send ${name} a proposal about it.`
                : `Open one of ${name}'s ideas or products and send your proposal from there.`
            }
            action={
              offerIdeas && newIdea ? (
                <Button asChild size="sm" className="h-11 sm:h-8">
                  <Link href={newIdea}>Post an idea</Link>
                </Button>
              ) : offerProducts && newProduct ? (
                <Button asChild size="sm" className="h-11 sm:h-8">
                  <Link href={newProduct}>List a product</Link>
                </Button>
              ) : null
            }
          />
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {targets.map((target) => {
              const Icon = target.kind === "idea" ? Lightbulb : Package
              const query = new URLSearchParams({ to, [target.kind]: target.id })
              if (matchId) query.set("match", matchId)
              return (
                <li key={target.id}>
                  <Link
                    href={`/app/proposals/new?${query.toString()}`}
                    className="flex min-h-11 items-center gap-3 p-4 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
                  >
                    <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-medium">{target.title}</span>
                    <span className="text-sm text-muted-foreground">
                      {target.kind === "idea" ? "Your idea" : "Your product"}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
  }

  const target = ideaId
    ? { kind: "idea" as const, id: ideaId }
    : { kind: "product" as const, id: productId ?? "" }
  const context = await loadSendContext(db, { recipientId: to, target })
  // Never show the title of a draft or archived item someone else owns (their pages are 404s too).
  if (!context || !canViewProposalTarget(user, context.target)) notFound()
  const counterpartRole = partyRole(context.target, to)
  const names = await loadPartyNames(db, [{ userId: to, role: counterpartRole }])
  const recipientName = names.get(to)?.name ?? "them"
  const handle = names.get(to)?.handle ?? null
  const reason = sendBlockReason(user, context)
  const existing = reason
    ? null
    : await findOpenProposalBetween(db, { userA: user.id, userB: to, target })
  const kindLabel = context.target.kind === "idea" ? "idea" : "product"

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Header
        description={`To ${recipientName}, about the ${kindLabel} “${context.target.title}”.`}
      />
      <div className="flex items-center gap-3 rounded-xl border bg-card p-4 text-sm shadow-xs">
        {context.target.kind === "idea" ? (
          <Lightbulb className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <Package className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{context.target.title}</p>
          <p className="text-muted-foreground">
            {context.target.ownerUserId === user.id ? "Your" : `${recipientName}'s`} {kindLabel}
            {" · "}
            {handle ? (
              <Link
                href={`/${counterpartRole === "creator" ? "c" : "b"}/${handle}`}
                className="underline underline-offset-2"
              >
                @{handle}
              </Link>
            ) : (
              recipientName
            )}
            {` (${counterpartRole})`}
          </p>
        </div>
      </div>

      {reason || !canSendProposal(user, context) ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>You can&apos;t send this proposal</AlertTitle>
          <AlertDescription>{reason ?? "You don't have permission to do that."}</AlertDescription>
        </Alert>
      ) : existing ? (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>You already have an open proposal with them about this</AlertTitle>
          <AlertDescription>
            <p>Answer or withdraw it before you send a new one.</p>
            <Button asChild size="sm" variant="outline" className="mt-2 h-11 sm:h-8">
              <Link href={`/app/proposals/${existing}`}>Open the proposal</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <ProposalForm
          mode="send"
          hidden={{
            to,
            targetKind: context.target.kind,
            targetId: context.target.id,
            ...(matchId ? { match: matchId } : {}),
          }}
          defaults={{
            scope: "",
            message: "",
            creatorSplitPct:
              context.target.preferredSplitBuilderPct !== null
                ? 100 - context.target.preferredSplitBuilderPct
                : DEFAULT_CREATOR_SPLIT_PCT,
            timelineWeeks: DEFAULT_TIMELINE_WEEKS,
          }}
        />
      )}
    </div>
  )
}
