import { Skeleton } from "@/components/ui/skeleton"

/**
 * Placeholders while a collab page loads: the header (kind, title, stage, the section links), then
 * blocks the size of the real content. Announced once to screen readers.
 */
export function CollabPageSkeleton({
  label,
  blocks = 3,
}: {
  label: string
  /** How many content blocks to sketch. */
  blocks?: number
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-6" role="status" aria-label={label}>
      <div className="space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Skeleton className="h-11 w-full max-w-md" />
      {Array.from({ length: blocks }, (_, index) => (
        <Skeleton key={index} className="h-28 w-full rounded-xl" />
      ))}
    </div>
  )
}
