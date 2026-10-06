import { ArrowLeft, Sparkles } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { AudienceSummaryForm } from "@/components/audience/audience-summary-form"
import { AudienceStats } from "@/components/audience/audience-stats"
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { PageHeader } from "@/components/shared/page-header"
import { SyncRefresher } from "@/components/social/sync-refresher"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { getDb } from "@/lib/db/client"
import { requireOnboardingStep } from "@/lib/onboarding/page"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"
import { loadAudienceOverview } from "@/lib/social/audience"
import { canViewOwnAudience } from "@/lib/social/authz"

export const metadata: Metadata = { title: "Review your audience" }

/**
 * Creator onboarding, step "review" (§7.3 use 1, §12): the AI audience summary and topics, which
 * the creator can edit, next to the key stats it was written from. "Continue" stores their
 * version, records whether they accepted or edited the AI text (`ai.reviewed`) and moves on.
 * While the first sync or the summary is still running, the page refreshes itself.
 */
export default async function OnboardingReviewPage() {
  const { user, progress } = await requireOnboardingStep("creator.review")
  // The step's own rule too (§6 defence in depth): a creator's own audience data.
  if (!canViewOwnAudience(user)) redirect(ONBOARDING_STEP_PATHS.role)
  const overview = await loadAudienceOverview(getDb(), user.id)
  const { profile } = overview
  if (!profile) redirect(ONBOARDING_STEP_PATHS["creator.profile"])

  const hasConnections = overview.connections.length > 0
  const generated = profile.summaryGeneratedAt !== null && profile.summaryEditedAt === null

  return (
    <div className="space-y-8">
      <OnboardingProgress progress={progress} />

      <PageHeader
        title="Review how we describe your audience"
        description="This summary and these topics appear on your public profile and help us match you with builders. Change anything that isn't right."
      />

      {hasConnections ? (
        <AudienceStats overview={overview} headingLevel="h2" />
      ) : (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          You haven&apos;t connected an account yet, so there are no stats to summarise. Write a few
          sentences about your audience yourself, or{" "}
          <Link
            href={ONBOARDING_STEP_PATHS["creator.connect"]}
            className="font-medium text-foreground underline underline-offset-4"
          >
            go back and connect one
          </Link>
          .
        </p>
      )}

      <section aria-labelledby="summary-heading" className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="summary-heading" className="text-base font-semibold">
            Your audience in a few sentences
          </h2>
          {generated && !overview.summaryPending ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Sparkles className="size-3.5" aria-hidden="true" />
              Written by AI from your stats
            </span>
          ) : null}
        </div>

        {overview.summaryPending ? (
          <div className="space-y-3">
            <SyncRefresher message="Writing your audience summary…" />
            <div className="space-y-2" aria-hidden="true">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          </div>
        ) : (
          <AudienceSummaryForm
            // Remount when a new summary arrives, so the fields show it.
            key={profile.summaryGeneratedAt?.toISOString() ?? "none"}
            mode="review"
            summary={profile.audienceSummary}
            topics={profile.topics}
          />
        )}
      </section>

      <div className="border-t pt-6">
        {progress.previousHref ? (
          <Button asChild variant="ghost">
            <Link href={progress.previousHref}>
              <ArrowLeft aria-hidden="true" />
              Back
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  )
}
