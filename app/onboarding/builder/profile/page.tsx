import { ArrowLeft } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { BuilderProfileForm } from "@/components/profiles/builder-profile-form"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { canEditBuilderProfile } from "@/lib/auth/authz"
import { getDb } from "@/lib/db/client"
import { requireOnboardingStep } from "@/lib/onboarding/page"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"
import { builderProfilePageData } from "@/lib/profiles/page-data"

export const metadata: Metadata = { title: "Your builder profile" }

/**
 * Builder onboarding, step "profile" (§12, §16 Phase 1): name, handle, bio, skills, stack,
 * availability and deal preference. "Continue" creates the profile (or saves changes when the
 * builder comes back to this step) and moves on to the portfolio.
 */
export default async function OnboardingBuilderProfilePage() {
  const { user, progress } = await requireOnboardingStep("builder.profile")
  // Defence in depth (§19.9): the step guard already checks the path; the rule checks the role.
  if (!canEditBuilderProfile(user)) redirect(ONBOARDING_STEP_PATHS.role)
  const data = await builderProfilePageData(getDb(), user)

  return (
    <div className="space-y-8">
      <OnboardingProgress progress={progress} />

      <PageHeader
        title={data.exists ? "Your builder profile" : "Set up your builder profile"}
        description="Creators read this when they look for someone to build their idea. You can change it later in Settings."
      />

      <BuilderProfileForm
        source="onboarding"
        defaults={data.defaults}
        sharedHandleNote={data.sharedHandleNote}
      />

      {progress.previousHref ? (
        <Button asChild variant="ghost">
          <Link href={progress.previousHref}>
            <ArrowLeft aria-hidden="true" />
            Back
          </Link>
        </Button>
      ) : null}
    </div>
  )
}
