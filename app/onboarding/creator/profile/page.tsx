import { ArrowLeft } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { CreatorProfileForm } from "@/components/profiles/creator-profile-form"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { getDb } from "@/lib/db/client"
import { requireOnboardingStep } from "@/lib/onboarding/page"
import { countryOptions, languageOptions } from "@/lib/profiles/locale"
import { creatorProfilePageData } from "@/lib/profiles/page-data"

export const metadata: Metadata = { title: "Your creator profile" }

/**
 * Creator onboarding, step "profile" (§12, §16 Phase 1): name, handle, niche, bio, country and
 * languages. "Continue" creates the profile (or saves changes when the creator comes back to this
 * step) and moves on to connecting accounts.
 */
export default async function OnboardingCreatorProfilePage() {
  const { user, progress } = await requireOnboardingStep("creator.profile")
  const data = await creatorProfilePageData(getDb(), user)

  return (
    <div className="space-y-8">
      <OnboardingProgress progress={progress} />

      <PageHeader
        title={data.exists ? "Your creator profile" : "Set up your creator profile"}
        description="This is what builders see when they look for creators to work with. You can change it later in Settings."
      />

      <CreatorProfileForm
        source="onboarding"
        defaults={data.defaults}
        countries={countryOptions()}
        languages={languageOptions()}
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
