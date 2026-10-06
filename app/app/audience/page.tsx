import { CircleAlert, Globe2, Settings2, Sparkles, Users } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { AgeGenderChart } from "@/components/audience/age-gender-chart"
import { AudienceStats } from "@/components/audience/audience-stats"
import { CountryBars } from "@/components/audience/country-bars"
import { formatDateTimeUtc } from "@/components/audience/format"
import { RegenerateSummaryButton } from "@/components/audience/regenerate-summary-button"
import { SummaryEditor } from "@/components/audience/summary-editor"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { ConnectButton } from "@/components/social/connect-button"
import { ConnectResultAlert } from "@/components/social/connect-result-alert"
import { ConnectionStatusBadge } from "@/components/social/connection-status-badge"
import { ManualEntryDialog } from "@/components/social/manual-entry-dialog"
import { ProviderIcon } from "@/components/social/provider-icon"
import { ResyncButton } from "@/components/social/resync-button"
import { SyncRefresher } from "@/components/social/sync-refresher"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"
import { loadAudienceOverview } from "@/lib/social/audience"
import { canViewOwnAudience } from "@/lib/social/authz"
import { socialErrorMessage } from "@/lib/social/errors"
import type { ConnectionView } from "@/lib/social/view"

export const metadata: Metadata = { title: "Audience" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const RETURN_TO = "/app/audience"

/**
 * Creator → Audience (§12, §16 Phase 1 "a creator connects YouTube and sees /app/audience with
 * real data"): followers per platform, size tier, average views, engagement, top countries and
 * age/gender (with what the shares are of), the AI summary and topics (editable, regenerable),
 * when each platform last synced, resync, and connection health (expired → reconnect).
 *
 * Connect and Reconnect buttons here come back with `?connected=` / `?error=` (lib/social/
 * oauth-flow.ts), so every branch shows that outcome, the empty states included.
 */
export default async function AudiencePage({ searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const connectResult = <ConnectResultAlert searchParams={await searchParams} />

  if (!canViewOwnAudience(user)) {
    return (
      <div className="space-y-8">
        <PageHeader title="Audience" />
        {connectResult}
        <EmptyState
          icon={Users}
          title="Audience stats are for creators"
          description="Add the creator role to connect YouTube, Instagram or TikTok and see who follows you."
          action={
            <Button asChild size="sm">
              <Link href={ONBOARDING_STEP_PATHS.role}>Become a creator</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const overview = await loadAudienceOverview(getDb(), user.id)
  const { profile, connections } = overview

  if (!profile) {
    return (
      <div className="space-y-8">
        <PageHeader title="Audience" />
        {connectResult}
        <EmptyState
          icon={Users}
          title="Create your creator profile first"
          description="Your audience stats belong to your creator profile. It takes a minute."
          action={
            <Button asChild size="sm">
              <Link href={ONBOARDING_STEP_PATHS["creator.profile"]}>Create creator profile</Link>
            </Button>
          }
        />
      </div>
    )
  }

  if (connections.length === 0) {
    return (
      <div className="space-y-8">
        <PageHeader
          title="Audience"
          description="Who follows you, where they are and what they care about."
        />
        {connectResult}
        <EmptyState
          icon={Users}
          title="Connect an account to see your audience"
          description="Connect YouTube to get verified subscribers, views, engagement, countries and age groups. Instagram and TikTok work too, or enter your numbers by hand."
          action={
            <div className="flex flex-col items-center gap-2 sm:flex-row">
              <ConnectButton provider="youtube" returnTo={RETURN_TO} />
              <Button asChild variant="ghost">
                <Link href="/app/settings/connections">Other accounts</Link>
              </Button>
            </div>
          }
        />
      </div>
    )
  }

  const problems = connections.filter(
    (connection) => connection.health === "expired" || connection.health === "error",
  )
  const withDemographics = connections.filter(
    (connection) =>
      connection.latest &&
      (connection.latest.topCountries.length > 0 || connection.latest.ageGender !== null),
  )
  const summaryGenerated = profile.summaryGeneratedAt !== null && profile.summaryEditedAt === null

  return (
    <div className="space-y-10">
      <PageHeader
        title="Audience"
        description={
          overview.lastSyncedAt
            ? `Who follows you, where they are and what they care about. Last updated ${formatDateTimeUtc(overview.lastSyncedAt)}.`
            : "Who follows you, where they are and what they care about."
        }
        actions={
          <Button asChild variant="outline">
            <Link href="/app/settings/connections">
              <Settings2 aria-hidden="true" />
              Manage connections
            </Link>
          </Button>
        }
      />

      {connectResult}
      {overview.syncPending || overview.summaryPending ? <SyncRefresher /> : null}

      {problems.map((connection) => (
        <ProblemAlert key={connection.id} connection={connection} />
      ))}

      <AudienceStats overview={overview} />

      <section aria-labelledby="summary-heading" className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="summary-heading" className="text-base font-semibold">
            Audience summary
          </h2>
          {summaryGenerated ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Sparkles className="size-3.5" aria-hidden="true" />
              Written by AI
              {profile.summaryGeneratedAt
                ? ` on ${formatDateTimeUtc(profile.summaryGeneratedAt)}`
                : ""}
            </span>
          ) : profile.summaryEditedAt ? (
            <span className="text-xs text-muted-foreground">
              Edited by you; syncs keep your version
            </span>
          ) : null}
        </div>
        <Card>
          <CardContent className="space-y-4">
            <SummaryEditor
              key={`${profile.summaryGeneratedAt?.toISOString() ?? ""}-${profile.summaryEditedAt?.toISOString() ?? ""}`}
              summary={profile.audienceSummary}
              topics={profile.topics}
            >
              <div className="space-y-3">
                {profile.audienceSummary ? (
                  <p className="text-sm leading-relaxed text-pretty">{profile.audienceSummary}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {overview.summaryPending
                      ? "Your summary is being written…"
                      : "No summary yet. Regenerate it from your stats, or write your own."}
                  </p>
                )}
                {profile.topics.length > 0 ? (
                  <ul className="flex flex-wrap gap-1.5" aria-label="Topics">
                    {profile.topics.map((topic) => (
                      <li key={topic}>
                        <Badge variant="secondary">{topic}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </SummaryEditor>
            <div className="border-t pt-4">
              <RegenerateSummaryButton replacesEdit={profile.summaryEditedAt !== null} />
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="demographics-heading" className="space-y-4">
        <h2 id="demographics-heading" className="text-base font-semibold">
          Where your audience is, and who they are
        </h2>
        {withDemographics.length === 0 ? (
          <EmptyState
            icon={Globe2}
            title="No demographics yet"
            description={noDemographicsReason(connections)}
          />
        ) : (
          <div className="grid gap-4">
            {withDemographics.map((connection) => (
              <DemographicsCard key={connection.id} connection={connection} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="health-heading" className="space-y-4">
        <h2 id="health-heading" className="text-base font-semibold">
          Connection health
        </h2>
        <ul className="divide-y rounded-xl border bg-card">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <ProviderIcon provider={connection.provider} className="size-4" />
                  <span className="font-medium">{connection.label}</span>
                  <ConnectionStatusBadge health={connection.health} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {connection.lastSyncedAt
                    ? `${connection.source === "manual" ? "Entered" : "Last synced"} ${formatDateTimeUtc(connection.lastSyncedAt)}`
                    : "Not synced yet"}
                </p>
              </div>
              <HealthAction connection={connection} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function ProblemAlert({ connection }: { connection: ConnectionView }) {
  const expired = connection.health === "expired"
  return (
    <Alert variant={expired ? "destructive" : "default"}>
      <CircleAlert aria-hidden="true" />
      <AlertTitle>
        {expired
          ? `Reconnect ${connection.label} to keep your stats current`
          : `${connection.label} didn't sync`}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          {expired || !connection.lastSyncError
            ? `Access to ${connection.label} expired or was removed, so these are the numbers from the last update.`
            : socialErrorMessage(connection.lastSyncError, connection.label)}
        </p>
        {expired ? (
          <ConnectButton provider={connection.provider} returnTo={RETURN_TO} reconnect />
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

function HealthAction({ connection }: { connection: ConnectionView }) {
  if (connection.source === "manual") {
    return connection.provider === "github" ? null : (
      <div className="flex flex-col gap-2 sm:flex-row">
        <ConnectButton
          provider={connection.provider}
          returnTo={RETURN_TO}
          variant="outline"
          label={`Connect ${connection.label} to verify`}
        />
        <ManualEntryDialog provider={connection.provider} update triggerVariant="ghost" />
      </div>
    )
  }
  if (connection.status !== "active") {
    return <ConnectButton provider={connection.provider} returnTo={RETURN_TO} reconnect />
  }
  return <ResyncButton connectionId={connection.id} label={connection.label} />
}

const BASIS_NOTE: Record<string, string> = {
  youtube:
    "YouTube reports where your views came from and the ages and genders of signed-in viewers over the last 90 days. These are shares of viewers, not of subscribers.",
  instagram:
    "Instagram reports the countries, ages and genders of your followers. These are shares of followers.",
}

function DemographicsCard({ connection }: { connection: ConnectionView }) {
  const latest = connection.latest
  if (!latest) return null
  const countriesBasis = latest.countriesBasis ?? "audience"
  const ageBasis = latest.ageGender?.basis ?? countriesBasis
  return (
    <Card role="region" aria-labelledby={`demographics-${connection.id}`}>
      <CardHeader>
        <CardTitle id={`demographics-${connection.id}`} className="flex items-center gap-2">
          <ProviderIcon provider={connection.provider} className="size-4" />
          {connection.label} audience
        </CardTitle>
        <CardDescription>
          {BASIS_NOTE[connection.provider] ??
            `Shares of your ${countriesBasis}, as reported by ${connection.label}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-8 md:grid-cols-2">
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Top countries</h3>
          {latest.topCountries.length > 0 ? (
            <CountryBars
              countries={latest.topCountries}
              basis={latest.countriesBasis}
              caption={`${connection.label}: top countries by share of ${countriesBasis}`}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {connection.label} didn&apos;t report countries.
            </p>
          )}
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Age and gender</h3>
          {latest.ageGender && latest.ageGender.buckets.length > 0 ? (
            <AgeGenderChart
              ageGender={latest.ageGender}
              caption={`${connection.label}: share of ${ageBasis} by age group and gender`}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {connection.label} didn&apos;t report ages and genders
              {connection.provider === "instagram"
                ? " (Instagram shares them from 100 followers)"
                : ""}
              .
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function noDemographicsReason(connections: readonly ConnectionView[]): string {
  if (connections.every((connection) => connection.source === "manual")) {
    return "Numbers entered by hand don't include demographics. Connect YouTube or Instagram to see countries, ages and genders."
  }
  if (connections.every((connection) => connection.provider === "tiktok")) {
    return "TikTok doesn't share audience demographics. Connect YouTube or Instagram to see countries, ages and genders."
  }
  return "Your platforms haven't reported countries, ages or genders yet. They appear after a sync once there is enough data."
}
