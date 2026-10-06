import { Skeleton } from "@/components/ui/skeleton"

/** Placeholder while a Discover page loads: heading, tabs, a few cards the size of real ones. */
export function DiscoverSkeleton({ label = "Loading your matches" }: { label?: string }) {
  return (
    <div className="space-y-6" role="status" aria-label={label}>
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Skeleton className="h-11 w-72 max-w-full" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((card) => (
          <div key={card} className="space-y-3 rounded-xl border p-4">
            <div className="flex justify-between">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-7 w-12 rounded-full" />
            </div>
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-10 w-full" />
            <div className="flex justify-between border-t pt-3">
              <Skeleton className="h-9 w-40" />
              <Skeleton className="h-9 w-32" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
