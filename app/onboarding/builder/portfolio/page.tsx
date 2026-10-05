import { ArrowLeft } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { ContinueStepButton } from "@/components/onboarding/continue-step-button"
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { SkipStepButton } from "@/components/onboarding/skip-step-button"
import { FormActions } from "@/components/profiles/form-kit"
import { PortfolioManager } from "@/components/profiles/portfolio-manager"
import { PageHeader } from "@/components/shared/page-header"
import { ConnectionCard } from "@/components/social/connection-card"
import { ConnectResultAlert } from "@/components/social/connect-result-alert"
import { SyncRefresher } from "@/components/social/sync-refresher"
import { Button } from "@/components/ui/button"
import { now } from "@/lib/clock"
import { canEditBuilderProfile } from "@/lib/auth/authz"
import { getDb } from "@/lib/db/client"
import { requireOnboardingStep } from "@/lib/onboarding/page"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"
import { finishPortfolioStep } from "@/lib/profiles/actions"
import { portfolioPageItems } from "@/lib/profiles/page-data"
import { listUserConnections } from "@/lib/social/queries"
import { hasPendingSync, toConnectionView } from "@/lib/social/view"

export const metadata: Metadata = { title: "Your portfolio" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const RETURN_TO = ONBOARDING_STEP_PATHS["builder.portfolio"]

/**
 * Builder onboarding, step "portfolio" (§12, §16 Phase 1): connect GitHub (public stats on the
 * profile, §7.1) and/or add projects. Either one lets the builder continue; otherwise "Do this
 * later".
 */
export default async function OnboardingPortfolioPage({ searchParams }: Props) {
  const { user, progress, snapshot } = await requireOnboardingStep("builder.portfolio")
  // Defence in depth (§19.9): the step guard already checks the path; the rule checks the role.
  if (!canEditBuilderProfile(user)) redirect(ONBOARDING_STEP_PATHS.role)
  const params = await searchParams
  const db = getDb()
  const [items, connections] = await Promise.all([
    portfolioPageItems(db, user.id),
    listUserConnections(db, user.id),
  ])
  const githubView = connections
    .map(toConnectionView)
    .find((connection) => connection.provider === "github")
  const canContinue = items.length > 0 || snapshot.githubConnectionCount > 0

  return (
    <div className="space-y-8">
      <OnboardingProgress progress={progress} />

      <PageHeader
        title="Show what you've built"
        description="Creators choose builders by their work. Connect GitHub, add a few projects, or both."
      />

      <ConnectResultAlert searchParams={params} />
      {githubView && hasPendingSync([githubView], now()) ? <SyncRefresher /> : null}

      <section aria-labelledby="github-heading" className="space-y-3">
        <h2 id="github-heading" className="text-base font-semibold">
          GitHub
        </h2>
        <ConnectionCard
          provider="github"
          connection={githubView ?? null}
          returnTo={RETURN_TO}
          recommended
          headingLevel="h3"
        />
      </section>

      <section aria-labelledby="projects-heading" className="space-y-3">
        <div className="space-y-1">
          <h2 id="projects-heading" className="text-base font-semibold">
            Projects
          </h2>
          <p className="text-sm text-muted-foreground">
            Apps, tools, templates or AI utilities you made, shipped or not.
          </p>
        </div>
        <PortfolioManager items={items} source="onboarding" headingLevel="h3" />
      </section>

      <FormActions className="flex-col-reverse sm:justify-between">
        {progress.previousHref ? (
          <Button asChild variant="ghost" className="self-start">
            <Link href={progress.previousHref}>
              <ArrowLeft aria-hidden="true" />
              Back
            </Link>
          </Button>
        ) : (
          <span />
        )}
        {canContinue ? (
          <ContinueStepButton action={finishPortfolioStep} />
        ) : (
          <SkipStepButton step="builder.portfolio" />
        )}
      </FormActions>
    </div>
  )
}
