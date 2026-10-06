import { Badge } from "@/components/ui/badge"

/** Topics, skills or stack as a labelled list of chips. */
export function TagList({ label, tags }: { label: string; tags: readonly string[] }) {
  if (tags.length === 0) return null
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">{label}</h3>
      <ul className="flex flex-wrap gap-1.5" aria-label={label}>
        {tags.map((tag) => (
          <li key={tag}>
            <Badge variant="secondary">{tag}</Badge>
          </li>
        ))}
      </ul>
    </div>
  )
}
