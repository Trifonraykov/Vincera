import { UserX } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"

/** Shown for unknown handles and suspended accounts on `/c/[handle]` and `/b/[handle]`. */
export function ProfileNotFound({ kind }: { kind: "creator" | "builder" }) {
  return (
    <EmptyState
      icon={UserX}
      title={`We couldn't find that ${kind}`}
      description="The handle may be misspelled, or the profile is no longer available."
      action={
        <Button asChild size="sm" variant="outline">
          <Link href={kind === "creator" ? "/creators" : "/builders"}>
            Learn about {kind === "creator" ? "creators" : "builders"} here
          </Link>
        </Button>
      }
    />
  )
}
