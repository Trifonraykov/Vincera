import { Lightbulb } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { NewIdea } from "@/components/ideas/new-idea"
import { AppBarSlot } from "@/components/layout/app-bar-slot"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { canCreateIdea } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { findCreatorContext } from "@/lib/ideas/queries"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"

export const metadata: Metadata = { title: "New idea" }

/**
 * `/app/ideas/new` (§12): the idea brief drafter (§7.3.2) and the idea form. Creators only; others
 * go back to `/app/ideas`, which explains the role.
 */
export default async function NewIdeaPage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canCreateIdea(user), "/app/ideas")
  const profile = await findCreatorContext(getDb(), user.id)

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <AppBarSlot title="New idea" back="/app/ideas" />
      <PageHeader
        title="New idea"
        description="What does your audience keep asking for? Save it as a draft, or publish it so builders can find it."
      />
      {profile ? (
        <NewIdea />
      ) : (
        <EmptyState
          icon={Lightbulb}
          title="Create your creator profile first"
          description="Ideas belong to your creator profile. It takes a minute."
          action={
            <Button asChild size="sm">
              <Link href={ONBOARDING_STEP_PATHS["creator.profile"]}>Create creator profile</Link>
            </Button>
          }
        />
      )}
    </div>
  )
}
