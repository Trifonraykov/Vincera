import { Skeleton } from "@/components/ui/skeleton"

/**
 * Placeholder while a list page loads (proposals, messages, notifications): the heading, then a
 * few rows the size of the real ones. Announced once to screen readers.
 */
export function ListPageSkeleton({ label, tabs = false }: { label: string; tabs?: boolean }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6" role="status" aria-label={label}>
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      {tabs ? <Skeleton className="h-11 w-72 max-w-full" /> : null}
      <div className="divide-y rounded-xl border">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-start gap-3 p-4">
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Placeholder while one proposal loads: title, terms card, then the conversation. */
export function ProposalSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-6" role="status" aria-label="Loading the proposal">
      <div className="space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="space-y-3 rounded-xl border p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-16 w-full" />
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  )
}
