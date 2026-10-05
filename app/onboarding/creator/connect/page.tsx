import { ArrowLeft, Info } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { SkipStepButton } from "@/components/onboarding/skip-step-button"
import { PageHeader } from "@/components/shared/page-header"
import { ConnectionCard } from "@/components/social/connection-card"
import { ConnectResultAlert } from "@/components/social/connect-result-alert"
import { SyncRefresher } from "@/components/social/sync-refresher"
import { Button } from "@/components/ui/button"
import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import { requireOnboardingStep } from "@/lib/onboarding/page"
import { listUserConnections } from "@/lib/social/queries"
import { CREATOR_SOCIAL_PROVIDERS, type SocialProviderId } from "@/lib/social/types"
import { hasPendingSync, toConnectionView, type ConnectionView } from "@/lib/social/view"

import { ContinueButton } from "./continue-button"

export const metadata: Metadata = { title: "Connect your accounts" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const RETURN_TO = "/onboarding/creator/connect"

/**
 * Creator onboarding, step "connect" (§12, §16 Phase 1): connect YouTube (recommended; it works
 * end to end without Meta/TikTok app review, §7.1), Instagram or TikTok, or enter numbers by hand
 * (§7.1 fallback). "Continue" once something is connected; otherwise "Do this later".
 */
export default async function OnboardingConnectPage({ searchParams }: Props) {
  const { user, progress } = await requireOnboardingStep("creator.connect")
  const params = await searchParams
  const views = (await listUserConnections(getDb(), user.id)).map(toConnectionView)
  const byProvider = new Map<SocialProviderId, ConnectionView>(
    views.map((view) => [view.provider, view]),
  )
  const connectedCount = CREATOR_SOCIAL_PROVIDERS.filter((provider) => {
    const view = byProvider.get(provider)
    return view !== undefined && view.status !== "revoked"
  }).length

  return (
    <div className="space-y-8">
      <OnboardingProgress progress={progress} />

      <PageHeader
        title="Connect where your audience is"
        description="Builders pick partners by audience. Connect at least one account so we can show verified numbers on your profile and summarise who follows you."
      />

      <ConnectResultAlert searchParams={params} />
      {hasPendingSync(views, now()) ? <SyncRefresher /> : null}

      <div className="grid gap-4">
        {CREATOR_SOCIAL_PROVIDERS.map((provider) => (
          <ConnectionCard
            key={provider}
            provider={provider}
            connection={byProvider.get(provider) ?? null}
            returnTo={RETURN_TO}
            recommended={provider === "youtube"}
            allowManual
          />
        ))}
      </div>

      <p className="flex gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          Connecting is read-only: we never post or change anything, and you can disconnect any time
          in Settings → Connections, which deletes the stored data.
        </span>
      </p>

      <div className="flex flex-col-reverse gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
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
        {connectedCount > 0 ? <ContinueButton /> : <SkipStepButton step="creator.connect" />}
      </div>
    </div>
  )
}
