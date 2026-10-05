import { ShieldCheck } from "lucide-react"
import type { Metadata } from "next"

import { PageHeader } from "@/components/shared/page-header"
import { ConnectionCard } from "@/components/social/connection-card"
import { ConnectResultAlert } from "@/components/social/connect-result-alert"
import { SyncRefresher } from "@/components/social/sync-refresher"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import { canConnectSocial } from "@/lib/social/authz"
import { listUserConnections } from "@/lib/social/queries"
import { CREATOR_SOCIAL_PROVIDERS, type SocialProviderId } from "@/lib/social/types"
import { hasPendingSync, toConnectionView, type ConnectionView } from "@/lib/social/view"

export const metadata: Metadata = { title: "Connections" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const RETURN_TO = "/app/settings/connections"

/**
 * Settings → Connections (§12, §7.1): the social accounts behind the profile. Creators connect
 * YouTube, Instagram and TikTok (GitHub optional); builders connect GitHub. Each card connects,
 * resyncs, reconnects (after expiry) or disconnects (§14: deletes tokens and snapshots), and
 * creator providers offer the manual-entry fallback.
 */
export default async function ConnectionsSettingsPage({ searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  // The user's own connections only; each provider below is also checked (canConnectSocial).
  authorizePage(canManageOwnAccount(user))
  const params = await searchParams
  const views = (await listUserConnections(getDb(), user.id)).map(toConnectionView)
  const byProvider = new Map<SocialProviderId, ConnectionView>(
    views.map((view) => [view.provider, view]),
  )

  const audienceProviders = CREATOR_SOCIAL_PROVIDERS.filter((provider) =>
    canConnectSocial(user, provider),
  )
  const showGitHub = canConnectSocial(user, "github")
  const isBuilder = user.roles.includes("builder")

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader
        title="Connections"
        description="Accounts we read stats from to build your profile. Connecting is read-only and separate from how you sign in."
      />

      <ConnectResultAlert searchParams={params} />
      {hasPendingSync(views, now()) ? <SyncRefresher /> : null}

      {audienceProviders.length > 0 ? (
        <section aria-labelledby="audience-accounts" className="space-y-4">
          <div className="space-y-1">
            <h2 id="audience-accounts" className="text-base font-semibold">
              Audience accounts
            </h2>
            <p className="text-sm text-muted-foreground">
              Verified numbers from these accounts set your size tier and audience summary, which
              builders see on your profile.
            </p>
          </div>
          <div className="grid gap-4">
            {audienceProviders.map((provider) => (
              <ConnectionCard
                key={provider}
                provider={provider}
                connection={byProvider.get(provider) ?? null}
                returnTo={RETURN_TO}
                recommended={provider === "youtube"}
                allowManual
                headingLevel="h3"
              />
            ))}
          </div>
        </section>
      ) : null}

      {showGitHub ? (
        <section aria-labelledby="developer-accounts" className="space-y-4">
          <div className="space-y-1">
            <h2 id="developer-accounts" className="text-base font-semibold">
              Developer account{isBuilder ? "" : " (optional)"}
            </h2>
            <p className="text-sm text-muted-foreground">
              Your public GitHub stats (repositories, stars, languages) show on your builder
              profile.
            </p>
          </div>
          <ConnectionCard
            provider="github"
            connection={byProvider.get("github") ?? null}
            returnTo={RETURN_TO}
            recommended={isBuilder}
            headingLevel="h3"
          />
        </section>
      ) : null}

      <p className="flex gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          We store access tokens encrypted and only read statistics. Disconnecting deletes the
          tokens and every stat we stored from that account.
        </span>
      </p>
    </div>
  )
}
