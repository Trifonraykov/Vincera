import { CircleCheck, CircleDashed, Wallet } from "lucide-react"
import Link from "next/link"

import { formatExact } from "@/lib/proposals/display"
import type { CollabMember } from "@/lib/collabs/queries"
import { COLLAB_ROLE_LABELS } from "@/lib/collabs/display"
import { cn } from "@/lib/utils"

/**
 * The collab's members with their role and split, and optionally where each stands with the
 * agreement (signed or not) and payouts (§12: both must be payouts-ready to sign). Names link to
 * the public profile of their role when they have one.
 */
export function MemberList({
  members,
  viewerId,
  signatures,
  payoutsReady,
  className,
}: {
  members: readonly CollabMember[]
  viewerId: string
  signatures?: ReadonlyMap<string, { typedName: string; signedAt: Date }>
  payoutsReady?: ReadonlyMap<string, boolean>
  className?: string
}) {
  return (
    <ul className={cn("divide-y overflow-hidden rounded-xl border bg-card shadow-xs", className)}>
      {members.map((member) => {
        const signature = signatures?.get(member.userId)
        const ready = payoutsReady?.get(member.userId)
        const you = member.userId === viewerId
        const profileHref = member.handle
          ? `/${member.role === "creator" ? "c" : "b"}/${member.handle}`
          : null
        return (
          <li key={member.userId} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 font-medium">
                {profileHref ? (
                  <Link
                    href={profileHref}
                    className="break-words underline-offset-4 hover:underline"
                  >
                    {member.name}
                  </Link>
                ) : (
                  <span className="break-words">{member.name}</span>
                )}
                {you ? (
                  <span className="text-sm font-normal text-muted-foreground">(you)</span>
                ) : null}
              </p>
              <p className="text-sm text-muted-foreground">
                {COLLAB_ROLE_LABELS[member.role]} ·{" "}
                <span className="font-medium text-foreground tabular-nums">{member.splitPct}%</span>{" "}
                of revenue
              </p>
            </div>
            {signatures || payoutsReady ? (
              <div className="flex flex-col gap-1 text-sm sm:items-end">
                {signatures ? (
                  signature ? (
                    <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                      <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
                      <span>
                        Signed as “{signature.typedName}”{" "}
                        <time
                          dateTime={signature.signedAt.toISOString()}
                          className="text-muted-foreground"
                        >
                          {formatExact(signature.signedAt)}
                        </time>
                      </span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <CircleDashed className="size-4 shrink-0" aria-hidden="true" />
                      Not signed yet
                    </span>
                  )
                ) : null}
                {payoutsReady && ready !== undefined ? (
                  <span
                    className={cn(
                      "flex items-center gap-1.5",
                      ready ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400",
                    )}
                  >
                    <Wallet className="size-4 shrink-0" aria-hidden="true" />
                    {ready ? "Payouts ready" : "Payouts not set up yet"}
                  </span>
                ) : null}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
