import { ExternalLink, Link2, Rocket } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { AppBarSlot } from "@/components/layout/app-bar-slot"
import { CopyButton } from "@/components/launches/copy-button"
import { LaunchKitGenerator } from "@/components/launches/launch-kit"
import { LaunchStatusBadge } from "@/components/launches/status-badge"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { canViewLaunchSetup, isCollabMember } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { LAUNCH_KIT_PLATFORM_LABELS } from "@/lib/ai/prompts/launch-kit-shared"
import { loadKitContext } from "@/lib/launches/kit"
import { loadLaunchAccess } from "@/lib/launches/queries"
import { formatMoney } from "@/lib/money"

export const metadata: Metadata = { title: "Launch kit" }

type Props = { params: Promise<{ id: string }> }

/**
 * The launch kit (§12 `/app/launches/[id]/kit`, §7.3 use 4): the creator's tracked link to share
 * and AI-drafted posts for each of the creator's platforms, ready to copy. For the collab's
 * members once the launch has gone live; admins and anyone else get a 404 (it is a promotion
 * tool, not launch data).
 */
export default async function LaunchKitPage({ params }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  const access = await loadLaunchAccess(db, id)
  if (!access || !canViewLaunchSetup(user, access) || !isCollabMember(user, access)) notFound()
  const context = await loadKitContext(db, id)
  if (!context) notFound()
  const isCreator = context.creatorUserId === user.id

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <AppBarSlot title="Launch kit" back="/app/launches" />
      <PageHeader
        title={`Launch kit: ${context.title}`}
        description={
          isCreator
            ? "Share your tracked link so clicks and sales are counted for this launch."
            : "The creator's tracked link and post ideas for promoting the launch."
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <LaunchStatusBadge status={context.status} />
        {context.priceCents !== null ? (
          <span>{formatMoney(context.priceCents, context.currency)}</span>
        ) : null}
        <span aria-hidden="true">·</span>
        <Link
          href={`/app/collabs/${context.collabId}/launch`}
          className="inline-flex min-h-11 items-center underline-offset-4 hover:underline sm:min-h-0"
        >
          Launch setup
        </Link>
      </div>

      {!context.link ? (
        <EmptyState
          icon={Rocket}
          title="The kit is ready once the launch is live"
          description="Going live creates the creator's tracked link. Then come back here for posts to share."
          action={
            <Button asChild variant="outline" className="h-11 sm:h-9">
              <Link href={`/app/collabs/${context.collabId}/launch`}>Open the launch setup</Link>
            </Button>
          }
        />
      ) : (
        <>
          <section
            aria-labelledby="kit-link"
            className="space-y-3 rounded-xl border bg-card p-4 shadow-xs"
          >
            <h2 id="kit-link" className="flex items-center gap-2 font-semibold">
              <Link2 className="size-4" aria-hidden="true" />
              {isCreator ? "Your tracked link" : "The creator's tracked link"}
            </h2>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-3 py-2 text-sm">
                {context.link.url}
              </code>
              <CopyButton text={context.link.url} label="Copy the tracked link" />
            </div>
            <p className="text-sm text-muted-foreground">
              Put it in your bio, video descriptions and stories. Sales through it are counted for
              this launch.{" "}
              {context.status === "live" ? (
                <Link
                  href={`/p/${context.slug}`}
                  target="_blank"
                  className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
                >
                  See the product page
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </Link>
              ) : null}
            </p>
          </section>

          <section aria-labelledby="kit-posts" className="space-y-3">
            <h2 id="kit-posts" className="text-lg font-semibold">
              Post ideas
            </h2>
            <p className="text-sm text-muted-foreground">
              Three posts each for{" "}
              {context.platforms.map((p) => LAUNCH_KIT_PLATFORM_LABELS[p].name).join(", ")}, written
              from the launch and the creator&apos;s audience. Edit them to sound like you.
            </p>
            <LaunchKitGenerator launchId={context.launchId} />
          </section>
        </>
      )}
    </div>
  )
}
