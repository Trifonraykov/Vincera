import { Check, ExternalLink } from "lucide-react"

import { formatCompact, formatDateTimeUtc, formatPercent } from "@/components/audience/format"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardFooter, CardTitle } from "@/components/ui/card"
import { SOCIAL_PROVIDER_META } from "@/lib/social/catalog"
import { socialErrorMessage } from "@/lib/social/errors"
import type { CreatorSocialProviderId, SocialProviderId } from "@/lib/social/types"
import type { ConnectionView } from "@/lib/social/view"
import { cn } from "@/lib/utils"

import { ConnectButton } from "./connect-button"
import { ConnectionStatusBadge } from "./connection-status-badge"
import { DisconnectButton } from "./disconnect-button"
import { ManualEntryDialog } from "./manual-entry-dialog"
import { ProviderIcon } from "./provider-icon"
import { ResyncButton } from "./resync-button"

/** What each provider needs before connecting (CLAUDE.md §19.10), in plain words. */
export const PROVIDER_REQUIREMENTS: Record<SocialProviderId, readonly string[]> = {
  youtube: [
    "The Google account that owns your YouTube channel",
    "Read-only: we never post, comment or change anything",
  ],
  instagram: [
    "An Instagram Business or Creator account (switching is free in the Instagram app)",
    "Audience demographics appear once you have 100+ followers",
  ],
  tiktok: [
    "Profile stats and your recent public videos only",
    "TikTok doesn't share audience demographics with apps",
  ],
  github: [
    "Public repositories, stars, languages and contribution counts",
    "No access to private code",
  ],
}

const MANUAL_PROVIDERS: readonly SocialProviderId[] = ["youtube", "instagram", "tiktok"]

function isManualProvider(provider: SocialProviderId): provider is CreatorSocialProviderId {
  return MANUAL_PROVIDERS.includes(provider)
}

/**
 * One provider on /app/settings/connections and /onboarding/creator/connect: connect it, or see
 * its status and resync, reconnect, update or disconnect it.
 */
export function ConnectionCard({
  provider,
  connection,
  returnTo,
  recommended = false,
  allowManual = false,
  headingLevel = "h2",
}: {
  provider: SocialProviderId
  connection: ConnectionView | null
  /** Where the OAuth flow comes back to. */
  returnTo: string
  recommended?: boolean
  /** Offer "Enter manually" (§7.1 fallback; creator providers only). */
  allowManual?: boolean
  headingLevel?: "h2" | "h3"
}) {
  const meta = SOCIAL_PROVIDER_META[provider]
  const titleId = `connection-${provider}-title`
  const manualAllowed = allowManual && isManualProvider(provider)
  const Heading = headingLevel

  return (
    <Card
      role="region"
      aria-labelledby={titleId}
      className={cn(recommended && !connection && "border-primary/40 ring-1 ring-primary/20")}
    >
      <div className="flex items-start gap-4 px-6">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
          <ProviderIcon provider={provider} />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <CardTitle className="leading-snug">
              <Heading id={titleId} className="text-base font-semibold">
                {meta.label}
              </Heading>
            </CardTitle>
            {recommended && !connection ? <Badge>Recommended</Badge> : null}
            {connection ? <ConnectionStatusBadge health={connection.health} /> : null}
          </div>
          <CardDescription>
            {connection ? <ConnectedSummary connection={connection} /> : meta.blurb}
          </CardDescription>
        </div>
      </div>

      {connection ? (
        <ConnectionDetails connection={connection} />
      ) : (
        <CardContent>
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            {PROVIDER_REQUIREMENTS[provider].map((requirement) => (
              <li key={requirement} className="flex gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                <span>{requirement}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      )}

      <CardFooter className="flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-start">
        <ConnectionActions
          provider={provider}
          connection={connection}
          returnTo={returnTo}
          manualAllowed={manualAllowed}
          recommended={recommended}
        />
      </CardFooter>
    </Card>
  )
}

function ConnectedSummary({ connection }: { connection: ConnectionView }) {
  const name = connection.displayName ?? (connection.username ? `@${connection.username}` : null)
  if (connection.source === "manual") {
    return (
      <>
        Entered by you
        {connection.lastSyncedAt ? ` on ${formatDateTimeUtc(connection.lastSyncedAt)}` : ""}.{" "}
        {connection.verified
          ? "Our team checked your screenshot."
          : "Shown as unverified until our team checks your screenshot."}
      </>
    )
  }
  return (
    <>
      {name ? <span className="font-medium text-foreground">{name}</span> : "Connected"}
      {connection.lastSyncedAt
        ? ` · last synced ${formatDateTimeUtc(connection.lastSyncedAt)}`
        : " · waiting for the first sync"}
    </>
  )
}

function ConnectionDetails({ connection }: { connection: ConnectionView }) {
  const { latest } = connection
  const message =
    connection.health === "expired"
      ? `Access to ${connection.label} expired or was removed. Reconnect to keep your numbers current; until then your profile shows the last update.`
      : connection.health === "error" && connection.lastSyncError
        ? socialErrorMessage(connection.lastSyncError, connection.label)
        : null
  const audienceWord = connection.provider === "youtube" ? "Subscribers" : "Followers"

  return (
    <CardContent className="space-y-3">
      {message ? (
        <p
          role={connection.health === "expired" ? "alert" : undefined}
          className={cn(
            "text-sm",
            connection.health === "expired" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {message}
        </p>
      ) : null}
      {latest ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{audienceWord}</dt>
            <dd className="font-medium">{formatCompact(latest.followers)}</dd>
          </div>
          {connection.provider === "github" && connection.github ? (
            <>
              <div>
                <dt className="text-muted-foreground">Public repos</dt>
                <dd className="font-medium">{formatCompact(connection.github.publicRepos)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Stars</dt>
                <dd className="font-medium">{formatCompact(connection.github.totalStars)}</dd>
              </div>
            </>
          ) : connection.source === "oauth" ? (
            <>
              <div>
                <dt className="text-muted-foreground">Avg. views</dt>
                <dd className="font-medium">{formatCompact(latest.avgViews)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Engagement</dt>
                <dd className="font-medium">{formatPercent(latest.engagementRate)}</dd>
              </div>
            </>
          ) : null}
        </dl>
      ) : null}
      {connection.profileUrl && connection.source === "oauth" ? (
        <a
          href={connection.profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          View on {connection.label}
          <ExternalLink className="size-3.5" aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : null}
    </CardContent>
  )
}

function ConnectionActions({
  provider,
  connection,
  returnTo,
  manualAllowed,
  recommended,
}: {
  provider: SocialProviderId
  connection: ConnectionView | null
  returnTo: string
  manualAllowed: boolean
  recommended: boolean
}) {
  if (!connection) {
    return (
      <>
        <ConnectButton
          provider={provider}
          returnTo={returnTo}
          variant={recommended ? "default" : "outline"}
        />
        {manualAllowed && isManualProvider(provider) ? (
          <ManualEntryDialog provider={provider} triggerVariant="ghost" />
        ) : null}
      </>
    )
  }

  const disconnect = (
    <DisconnectButton
      connectionId={connection.id}
      label={connection.label}
      manual={connection.source === "manual"}
    />
  )
  if (connection.source === "manual") {
    return (
      <>
        <ConnectButton
          provider={provider}
          returnTo={returnTo}
          variant="outline"
          label={`Connect ${connection.label} to verify`}
        />
        {isManualProvider(provider) ? (
          <ManualEntryDialog provider={provider} update triggerVariant="ghost" />
        ) : null}
        {disconnect}
      </>
    )
  }
  if (connection.status !== "active") {
    return (
      <>
        <ConnectButton provider={provider} returnTo={returnTo} reconnect />
        {disconnect}
      </>
    )
  }
  return (
    <>
      <ResyncButton connectionId={connection.id} label={connection.label} />
      <ConnectButton
        provider={provider}
        returnTo={returnTo}
        reconnect
        variant="secondary"
        label="Reconnect"
      />
      {disconnect}
    </>
  )
}
