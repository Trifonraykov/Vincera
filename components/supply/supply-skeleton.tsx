import { Skeleton } from "@/components/ui/skeleton"

/** Loading state of the idea and product lists (shown while the page's data loads). */
export function SupplyListSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-6" role="status" aria-label={label}>
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-11 w-20 rounded-full sm:h-8" />
        <Skeleton className="h-11 w-24 rounded-full sm:h-8" />
        <Skeleton className="h-11 w-20 rounded-full sm:h-8" />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
    </div>
  )
}

/** Loading state of an idea or product page. */
export function SupplyDetailSkeleton({ label }: { label: string }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6" role="status" aria-label={label}>
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-20 rounded-xl" />
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  )
}
