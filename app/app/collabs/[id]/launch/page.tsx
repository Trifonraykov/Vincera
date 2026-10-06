import {
  CheckCircle2,
  Circle,
  ExternalLink,
  FileSignature,
  Link2,
  MessageSquareWarning,
  Rocket,
  Sparkles,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { CollabHeader } from "@/components/collabs/collab-header"
import { CopyButton } from "@/components/launches/copy-button"
import { LaunchFiles, LaunchImages, LicenseKeys } from "@/components/launches/launch-content"
import { LaunchForm } from "@/components/launches/launch-form"
import {
  ApproveButton,
  PauseButton,
  ResumeButton,
  StartLaunchButton,
} from "@/components/launches/launch-actions"
import { LaunchStatusBadge } from "@/components/launches/status-badge"
import { EmptyState } from "@/components/shared/empty-state"
import { MarkdownText } from "@/components/supply/markdown-text"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  canApproveLaunch,
  canEditLaunch,
  canPauseLaunch,
  canResumeLaunch,
  canViewCollab,
  canViewLaunchSetup,
  canWorkInCollab,
} from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { loadCollabSummary } from "@/lib/collabs/queries"
import { getDb } from "@/lib/db/client"
import { env } from "@/lib/env"
import {
  DELIVERY_TYPE_LABELS,
  joinList,
  LAUNCH_STATUS_DESCRIPTIONS,
  launchMediaPath,
  mediaName,
  missingForApproval,
  parseDeliveryConfig,
  parseMedia,
  PRICE_TAX_NOTE,
} from "@/lib/launches/fields"
import { loadLaunchSetup, memberApprovals } from "@/lib/launches/queries"
import { trackedLinkPath } from "@/lib/launches/tracked-links"
import { formatMoney } from "@/lib/money"
import { formatMoneyInput } from "@/lib/money-input"
import { formatExact } from "@/lib/proposals/display"

export const metadata: Metadata = { title: "Launch" }

type Props = { params: Promise<{ id: string }> }

/**
 * The collab's launch setup (§12 `/app/collabs/[id]/launch`, CLAUDE.md §19.32): once the agreement
 * is signed (stage `building`) a member starts the launch; either member edits the product page,
 * price and delivery (saving resets approvals), each approves the current version, then it goes to
 * admin review (or live with `AUTO_APPROVE_LAUNCHES`). Live: the product page, the creator's
 * tracked link, the launch kit and "Pause sales". Admins read (`canViewLaunchSetup`); anyone else
 * gets a 404.
 */
export default async function CollabLaunchPage({ params }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  const collab = await loadCollabSummary(db, id)
  if (!collab || !canViewCollab(user, collab)) notFound()

  const setup = await loadLaunchSetup(db, collab.id)
  const isMember = collab.memberUserIds.includes(user.id)

  if (!setup) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <CollabHeader collab={collab} viewerId={user.id} section="launch" />
        {collab.stage === "building" && canWorkInCollab(user, collab) ? (
          <EmptyState
            icon={Rocket}
            title="Ready to launch?"
            description="Set up the product page, the price and how buyers get it. You can both edit it; it goes live once you have both approved it and our team has checked it."
            action={<StartLaunchButton collabId={collab.id} />}
          />
        ) : collab.stage === "agreement" ? (
          <EmptyState
            icon={FileSignature}
            title="Sign the agreement first"
            description="The launch can be set up once you have both signed the agreement."
            action={
              isMember ? (
                <Button asChild variant="outline" className="h-11 sm:h-9">
                  <Link href={`/app/collabs/${collab.id}/agreement`}>Open the agreement</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <EmptyState
            icon={Rocket}
            title="No launch"
            description={
              collab.stage === "ended"
                ? "This collab ended without a launch."
                : "The members haven't started the launch yet."
            }
          />
        )}
      </div>
    )
  }

  const { launch, files, keys, defaultLink } = setup
  const access = {
    status: launch.status,
    collabStage: collab.stage,
    memberUserIds: collab.memberUserIds,
    approvedUserIds: memberApprovals(setup.approvals),
    pausedBy: launch.pausedBy,
  }
  if (!canViewLaunchSetup(user, access)) notFound()

  const canEdit = canEditLaunch(user, access)
  const config = parseDeliveryConfig(launch.deliveryConfig)
  const media = parseMedia(launch.media)
  const missing = missingForApproval({
    title: launch.title,
    priceCents: launch.priceCents,
    deliveryType: launch.deliveryType,
    deliveryConfig: config,
    fileCount: files.length,
    unassignedKeyCount: keys.unassigned,
  })
  const approved = new Set(access.approvedUserIds)
  const allApproved = collab.members.every((member) => approved.has(member.userId))
  const canApprove = canApproveLaunch(user, access)
  const canPause = canPauseLaunch(user, access)
  const canResume = canResumeLaunch(user, access) && allApproved
  const isPublic =
    launch.status === "live" || launch.status === "paused" || launch.status === "ended"
  const linkUrl = defaultLink
    ? new URL(trackedLinkPath(defaultLink.code), env.NEXT_PUBLIC_APP_URL).toString()
    : null
  const keysChangeable =
    isMember && launch.status !== "ended" && collab.stage !== "ended" && user.status === "active"

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <CollabHeader collab={collab} viewerId={user.id} section="launch" />

      <section
        aria-labelledby="launch-status"
        className="space-y-4 rounded-xl border bg-card p-4 shadow-xs"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="launch-status" className="font-semibold">
            Launch status
          </h2>
          <LaunchStatusBadge status={launch.status} />
        </div>
        <p className="text-sm text-pretty text-muted-foreground">
          {LAUNCH_STATUS_DESCRIPTIONS[launch.status]}
        </p>

        {launch.status === "draft" && launch.reviewNote ? (
          <Alert>
            <MessageSquareWarning aria-hidden="true" />
            <AlertTitle>Our team asked for changes</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap">{launch.reviewNote}</AlertDescription>
          </Alert>
        ) : null}
        {launch.status === "paused" && launch.pausedBy !== "member" ? (
          <Alert>
            <MessageSquareWarning aria-hidden="true" />
            <AlertTitle>Paused by our team</AlertTitle>
            <AlertDescription>
              Sales start again once our team resumes the launch. Check your messages and email.
            </AlertDescription>
          </Alert>
        ) : null}

        {launch.status !== "ended" ? (
          <ul className="grid gap-2 sm:grid-cols-2" aria-label="Approvals">
            {collab.members.map((member) => {
              const ok = approved.has(member.userId)
              return (
                <li
                  key={member.userId}
                  className="flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                >
                  {ok ? (
                    <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />
                  ) : (
                    <Circle className="size-4 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {member.userId === user.id ? "You" : member.name}
                  </span>
                  <span className="text-muted-foreground">{ok ? "Approved" : "Not yet"}</span>
                </li>
              )
            })}
          </ul>
        ) : null}

        {missing.length > 0 && (launch.status === "draft" || launch.status === "paused") ? (
          <p className="text-sm text-muted-foreground">
            Before you can approve it, add {joinList(missing)}.
          </p>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
          {canApprove && missing.length === 0 ? <ApproveButton launchId={launch.id} /> : null}
          {launch.status === "paused" && isMember && canResume ? (
            <ResumeButton launchId={launch.id} />
          ) : null}
          {canPause && isMember ? <PauseButton launchId={launch.id} title={launch.title} /> : null}
          {isPublic ? (
            <Button asChild variant="outline" className="h-11 w-full sm:h-9 sm:w-auto">
              <Link href={`/p/${launch.slug}`} target="_blank">
                <ExternalLink aria-hidden="true" />
                View product page
              </Link>
            </Button>
          ) : null}
          {launch.wentLiveAt && isMember ? (
            <Button asChild variant="outline" className="h-11 w-full sm:h-9 sm:w-auto">
              <Link href={`/app/launches/${launch.id}/kit`}>
                <Sparkles aria-hidden="true" />
                Launch kit
              </Link>
            </Button>
          ) : null}
        </div>
        {launch.wentLiveAt ? (
          <p className="text-xs text-muted-foreground">
            Live since {formatExact(launch.wentLiveAt)}.
          </p>
        ) : null}
      </section>

      {linkUrl ? (
        <section
          aria-labelledby="tracked-link"
          className="space-y-3 rounded-xl border bg-card p-4 shadow-xs"
        >
          <h2 id="tracked-link" className="flex items-center gap-2 font-semibold">
            <Link2 className="size-4" aria-hidden="true" />
            The creator&apos;s tracked link
          </h2>
          <p className="text-sm text-muted-foreground">
            Share this link: clicks and sales through it are counted for this launch.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-3 py-2 text-sm">
              {linkUrl}
            </code>
            <CopyButton text={linkUrl} label="Copy the tracked link" />
          </div>
        </section>
      ) : null}

      <section aria-labelledby="launch-setup" className="space-y-4">
        <h2 id="launch-setup" className="text-lg font-semibold">
          Product page
        </h2>
        {canEdit ? (
          <LaunchForm
            launchId={launch.id}
            appUrl={env.NEXT_PUBLIC_APP_URL}
            slugLocked={launch.wentLiveAt !== null}
            hasApprovals={setup.approvals.length > 0}
            defaults={{
              title: launch.title,
              tagline: launch.tagline ?? "",
              descriptionMd: launch.descriptionMd ?? "",
              price: launch.priceCents === null ? "" : formatMoneyInput(launch.priceCents),
              slug: launch.slug,
              deliveryType: launch.deliveryType ?? "",
              deliveryUrl: config?.type === "url" ? config.url : "",
              instructions: config?.type === "license_key" ? (config.instructions ?? "") : "",
            }}
          />
        ) : (
          <div className="space-y-4 rounded-xl border p-4">
            {launch.status === "live" && isMember ? (
              <p className="text-sm text-muted-foreground">
                Pause sales to change the product page.
              </p>
            ) : null}
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Title</dt>
                <dd className="font-medium break-words">{launch.title}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Price</dt>
                <dd className="font-medium">
                  {launch.priceCents === null
                    ? "Not set"
                    : `${formatMoney(launch.priceCents, launch.currency)} · ${PRICE_TAX_NOTE}`}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Delivery</dt>
                <dd className="font-medium">
                  {launch.deliveryType
                    ? DELIVERY_TYPE_LABELS[launch.deliveryType].title
                    : "Not set"}
                  {config?.type === "url" ? (
                    <span className="block truncate font-normal text-muted-foreground">
                      {config.url}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Page address</dt>
                <dd className="font-medium break-all">/p/{launch.slug}</dd>
              </div>
            </dl>
            {launch.tagline ? <p className="text-sm">{launch.tagline}</p> : null}
            {launch.descriptionMd ? <MarkdownText source={launch.descriptionMd} /> : null}
          </div>
        )}
      </section>

      <section aria-label="Images and delivery" className="space-y-8 rounded-xl border p-4">
        <LaunchImages
          launchId={launch.id}
          canEdit={canEdit}
          media={media.map((item) => ({
            name: mediaName(item.url),
            alt: item.alt,
            src: launchMediaPath(launch.id, item.url),
          }))}
        />
        {launch.deliveryType === "file" ? (
          <LaunchFiles launchId={launch.id} canEdit={canEdit} files={files} />
        ) : null}
        {launch.deliveryType === "license_key" ? (
          <LicenseKeys
            launchId={launch.id}
            unassigned={keys.unassigned}
            assigned={keys.assigned}
            canChange={keysChangeable}
          />
        ) : null}
        {launch.deliveryType === null ? (
          <p className="text-sm text-muted-foreground">
            Choose how buyers get the product and save; files or license keys are added here.
          </p>
        ) : null}
      </section>
    </div>
  )
}
