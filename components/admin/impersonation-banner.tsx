import { Eye } from "lucide-react"

import { Button } from "@/components/ui/button"
import { stopImpersonation } from "@/lib/admin/actions"
import type { ActiveImpersonation } from "@/lib/auth/impersonation"

/**
 * The read-only "view as" banner (§6; CLAUDE.md §19.38), passed to `AppShell` by both layouts
 * while `getViewer().impersonation` is set. Sticky under the top bars; "Stop viewing" is a plain
 * form (works before hydration) with a 44 px target on phones.
 */
export function ImpersonationBanner({
  impersonation,
}: {
  impersonation: Pick<ActiveImpersonation, "expiresAt"> & {
    target: { name: string | null; email: string | null }
  }
}) {
  const name = impersonation.target.name ?? impersonation.target.email ?? "this user"
  const until = impersonation.expiresAt.toISOString().slice(11, 16)
  return (
    <div
      role="status"
      data-impersonation-banner
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-300 bg-amber-100 py-2 px-safe-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50"
    >
      <Eye className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        Viewing as <strong className="font-semibold break-words">{name}</strong> · read-only · until{" "}
        {until} UTC
      </p>
      <form action={stopImpersonation}>
        <Button type="submit" size="sm" variant="outline" className="h-11 bg-background sm:h-8">
          Stop viewing
        </Button>
      </form>
    </div>
  )
}
