import { Skeleton } from "@/components/ui/skeleton"

/** The feed while its first page loads: the header and two card-shaped blocks. */
export default function FeedLoading() {
  return (
    <div className="mx-auto w-full max-w-[560px] space-y-5" aria-busy="true">
      <div className="space-y-2 px-1">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-60" />
      </div>
      {[0, 1].map((key) => (
        <Skeleton key={key} className="aspect-[4/5] w-full rounded-[28px]" />
      ))}
      <span className="sr-only">Loading the feed</span>
    </div>
  )
}
