import { Badge } from "@/components/ui/badge"

/** Topics as small chips that wrap (never widen the page). */
export function TopicList({ topics, label }: { topics: readonly string[]; label: string }) {
  if (topics.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={label}>
      {topics.map((topic) => (
        <li key={topic}>
          <Badge variant="secondary" className="max-w-full font-normal whitespace-normal">
            {topic}
          </Badge>
        </li>
      ))}
    </ul>
  )
}
