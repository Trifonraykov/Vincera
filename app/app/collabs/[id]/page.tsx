import {
  ArrowRight,
  CalendarClock,
  Check,
  FileSignature,
  Hammer,
  ListChecks,
  MessagesSquare,
  Rocket,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { CollabHeader } from "@/components/collabs/collab-header"
import { MemberList } from "@/components/collabs/member-list"
import { Button } from "@/components/ui/button"
import { loadActiveAgreement } from "@/lib/agreements/queries"
import { canViewCollab, canWorkInCollab } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { now } from "@/lib/clock"
import {
  COLLAB_STAGE_DESCRIPTIONS,
  COLLAB_STAGE_LABELS,
  COLLAB_STAGE_ORDER,
} from "@/lib/collabs/display"
import { countOpenTasks, loadCollabSummary, loadPayoutsReadiness } from "@/lib/collabs/queries"
import { getDb } from "@/lib/db/client"
import { formatExact, formatRelative } from "@/lib/proposals/display"
import { formatTimeline } from "@/lib/proposals/fields"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Collab" }

type Props = { params: Promise<{ id: string }> }

/**
 * One collab (§12 `/app/collabs/[id]`): what it is about and with whom, the members' splits, the
 * stage on the way from agreement to live, what to do next (sign the agreement, plan the work, …),
 * the agreed scope and timeline, and links to the agreement, tasks and messages. Members and
 * admins (read-only) only (`canViewCollab`, §6); anyone else gets a 404.
 */
export default async function CollabPage({ params }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  const collab = await loadCollabSummary(db, id)
  if (!collab || !canViewCollab(user, collab)) notFound()

  const [agreement, readiness, taskCounts] = await Promise.all([
    loadActiveAgreement(db, collab.id),
    loadPayoutsReadiness(db, collab.memberUserIds),
    countOpenTasks(db, collab.id),
  ])
  const canWork = canWorkInCollab(user, collab)
  const isMember = collab.memberUserIds.includes(user.id)
  const signed = new Set(agreement?.signatures.map((signature) => signature.userId) ?? [])
  const others = collab.members.filter((member) => member.userId !== user.id)
  const at = now()
  const stageIndex = COLLAB_STAGE_ORDER.indexOf(collab.stage as (typeof COLLAB_STAGE_ORDER)[number])
  const yourTasks = taskCounts.assignedTo.get(user.id) ?? 0

  let next: { icon: typeof FileSignature; title: string; body: string; href: string; label: string }
  if (collab.stage === "agreement" && isMember && !signed.has(user.id)) {
    next = {
      icon: FileSignature,
      title: "Sign the agreement",
      body: readiness.get(user.id)
        ? "Read the agreement with your terms and sign it by typing your full name."
        : "Set up payouts first, then read the agreement and sign it by typing your full name.",
      href: `/app/collabs/${collab.id}/agreement`,
      label: "Read and sign",
    }
  } else if (collab.stage === "agreement") {
    const waiting = others.filter((member) => !signed.has(member.userId))
    next = {
      icon: FileSignature,
      title: "Waiting for signatures",
      body: `${waiting.map((member) => member.name).join(" and ") || "Your collaborator"} still has to sign. Meanwhile you can plan the work in Tasks.`,
      href: `/app/collabs/${collab.id}/agreement`,
      label: "See the agreement",
    }
  } else if (collab.stage === "building") {
    next = {
      icon: Hammer,
      title: "Build it together",
      body:
        taskCounts.open > 0
          ? `${taskCounts.open} open ${taskCounts.open === 1 ? "task" : "tasks"}${yourTasks > 0 ? `, ${yourTasks} for you` : ""}. Launch setup comes once it's ready.`
          : "Break the work into tasks and decide who does what.",
      href: `/app/collabs/${collab.id}/tasks`,
      label: "Open the tasks",
    }
  } else {
    next = {
      icon: collab.stage === "ended" ? Check : Rocket,
      title: COLLAB_STAGE_LABELS[collab.stage],
      body: COLLAB_STAGE_DESCRIPTIONS[collab.stage],
      href: `/app/collabs/${collab.id}/messages`,
      label: "Open the messages",
    }
  }
  const NextIcon = next.icon

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <CollabHeader
        collab={collab}
        viewerId={user.id}
        section="overview"
        badges={{
          tasks: { count: taskCounts.open, label: `${taskCounts.open} open tasks` },
        }}
      />

      {isMember || collab.stage !== "ended" ? (
        <section
          aria-labelledby="next-step"
          className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs sm:flex-row sm:items-center"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
            <NextIcon className="size-5 text-muted-foreground" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <h2 id="next-step" className="font-semibold">
              {next.title}
            </h2>
            <p className="text-sm text-pretty text-muted-foreground">{next.body}</p>
          </div>
          {isMember ? (
            <Button asChild className="h-11 sm:h-9">
              <Link href={next.href}>
                {next.label}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="stage-heading" className="space-y-3">
        <h2 id="stage-heading" className="font-semibold">
          Progress
        </h2>
        {collab.stage === "ended" ? (
          <p className="text-sm text-muted-foreground">
            {COLLAB_STAGE_DESCRIPTIONS.ended}
            {collab.endedAt ? ` Ended ${formatExact(collab.endedAt)}.` : null}
          </p>
        ) : (
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {COLLAB_STAGE_ORDER.map((stage, index) => {
              const state =
                index < stageIndex ? "done" : index === stageIndex ? "current" : "upcoming"
              return (
                <li
                  key={stage}
                  aria-current={state === "current" ? "step" : undefined}
                  className={cn(
                    "flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                    state === "current" && "border-primary bg-primary/5 font-medium",
                    state === "done" && "text-muted-foreground",
                    state === "upcoming" && "border-dashed text-muted-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums",
                      state === "done" && "border-transparent bg-emerald-600 text-white",
                      state === "current" && "border-primary text-primary",
                    )}
                    aria-hidden="true"
                  >
                    {state === "done" ? <Check className="size-3" /> : index + 1}
                  </span>
                  <span>
                    {COLLAB_STAGE_LABELS[stage]}
                    <span className="sr-only">
                      {state === "done" ? " (done)" : state === "current" ? " (now)" : ""}
                    </span>
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </section>

      <section aria-labelledby="members-heading" className="space-y-3">
        <h2 id="members-heading" className="font-semibold">
          Members and split
        </h2>
        <MemberList members={collab.members} viewerId={user.id} />
        <p className="text-xs text-muted-foreground">
          The split applies to what is left of each sale after taxes, payment fees and the platform
          fee.
        </p>
      </section>

      {agreement ? (
        <section aria-labelledby="scope-heading" className="space-y-3">
          <h2 id="scope-heading" className="font-semibold">
            What you agreed to build
          </h2>
          <div className="space-y-3 rounded-xl border bg-card p-4 text-sm shadow-xs">
            <p className="break-words whitespace-pre-wrap">{agreement.terms.scope}</p>
            <p className="flex items-center gap-2 text-muted-foreground">
              <CalendarClock className="size-4 shrink-0" aria-hidden="true" />
              Aim: ready to launch within {formatTimeline(agreement.terms.timelineWeeks)}
            </p>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="shortcuts-heading" className="space-y-3">
        <h2 id="shortcuts-heading" className="sr-only">
          Shortcuts
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Shortcut
            href={`/app/collabs/${collab.id}/agreement`}
            icon={FileSignature}
            title="Agreement"
            detail={
              agreement?.status === "signed"
                ? "Signed by both"
                : `${signed.size} of ${collab.members.length} signed`
            }
          />
          <Shortcut
            href={`/app/collabs/${collab.id}/tasks`}
            icon={ListChecks}
            title="Tasks"
            detail={`${taskCounts.open} open · ${taskCounts.done} done`}
          />
          <Shortcut
            href={`/app/collabs/${collab.id}/messages`}
            icon={MessagesSquare}
            title="Messages"
            detail={canWork ? "Talk it through" : "Read the conversation"}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Started {formatExact(collab.createdAt)} · last activity{" "}
          {formatRelative(collab.lastActivityAt, at)}
        </p>
      </section>
    </div>
  )
}

function Shortcut({
  href,
  icon: Icon,
  title,
  detail,
}: {
  href: string
  icon: typeof FileSignature
  title: string
  detail: string
}) {
  return (
    <Link
      href={href}
      className="flex min-h-11 items-center gap-3 rounded-xl border bg-card p-3 shadow-xs transition-colors outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </Link>
  )
}
