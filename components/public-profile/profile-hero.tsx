import { BadgeCheck } from "lucide-react"
import type { ReactNode } from "react"

/** Name, handle, role and badges at the top of a public profile. */
export function ProfileHero({
  displayName,
  handle,
  roleLabel,
  verified,
  badges,
  bio,
  meta,
}: {
  displayName: string
  handle: string
  roleLabel: string
  /** Shows a check next to the name (a verified creator account or builder profile). */
  verified: boolean
  badges?: ReactNode
  bio: string | null
  meta?: readonly string[]
}) {
  const initials = displayName
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase()

  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
      <div
        className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary text-xl font-semibold text-primary-foreground"
        aria-hidden="true"
      >
        {initials || "?"}
      </div>
      <div className="min-w-0 space-y-3">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{roleLabel}</p>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight text-balance">
            {displayName}
            {verified ? (
              <BadgeCheck className="size-5 text-primary" aria-label="Verified" role="img" />
            ) : null}
          </h1>
          <p className="text-sm text-muted-foreground">@{handle}</p>
        </div>
        {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}
        {bio ? <p className="max-w-prose text-pretty">{bio}</p> : null}
        {meta && meta.length > 0 ? (
          <p className="text-sm text-muted-foreground">{meta.join(" · ")}</p>
        ) : null}
      </div>
    </header>
  )
}
