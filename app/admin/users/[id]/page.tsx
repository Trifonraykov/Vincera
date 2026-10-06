import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Facts, formatUtc, Section, StatusPill } from "@/components/admin/admin-ui"
import {
  GrantAdminButton,
  RevokeAdminButton,
  SuspendButton,
  UnsuspendButton,
  VerifyAppStoreButton,
  VerifyConnectionButton,
  ViewAsButton,
} from "@/components/admin/user-actions"
import { PageHeader } from "@/components/shared/page-header"
import { STAGE_TEXT } from "@/lib/admin/fields"
import { listAuditLog } from "@/lib/admin/queries"
import { loadAdminUserDetail } from "@/lib/admin/users"
import {
  canGrantAdmin,
  canImpersonate,
  canManageUsers,
  canRevokeAdmin,
  canSuspendUser,
} from "@/lib/auth/authz"
import { adminAuditActionLabel } from "@/lib/admin/audit"
import { authorizePage, isImpersonating, requireAdmin } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { loadImportPanel } from "@/lib/listings/queries"
import { evidenceViewUrl } from "@/lib/social/manual"

export const metadata: Metadata = { title: "User" }

type Props = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const PAYOUTS_TEXT = {
  not_started: "Not started",
  action_required: "Action required",
  verifying: "Verifying",
  restricted: "Restricted",
  ready: "Ready",
} as const

/**
 * One account (Phase 6; CLAUDE.md §19.38 "Users (admin)"): roles, status, connections (manual
 * ones with Verify), Stripe status and collabs; suspend / lift, grant / revoke admin, and "view
 * as". Actions are hidden while the admin is viewing as someone (every save is refused then).
 */
export default async function AdminUserPage({ params }: Props) {
  const user = await requireAdmin()
  authorizePage(canManageUsers(user), "/app")
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const db = getDb()
  const detail = await loadAdminUserDetail(db, id)
  if (!detail) notFound()
  const readOnly = await isImpersonating()
  const imports = await loadImportPanel(db, id)
  const name = detail.name ?? detail.email ?? "this account"
  const audit = await listAuditLog(db, { targetType: "user", targetId: detail.id })
  const evidenceLinks = new Map<string, string | null>()
  for (const connection of detail.connections) {
    if (connection.source === "manual" && connection.hasEvidence) {
      evidenceLinks.set(connection.id, await evidenceViewUrl(db, user, connection.id))
    }
  }

  const actions = readOnly ? null : (
    <>
      {canImpersonate(user, detail) ? <ViewAsButton userId={detail.id} name={name} /> : null}
      {canSuspendUser(user, detail) ? (
        detail.status === "suspended" ? (
          <UnsuspendButton userId={detail.id} />
        ) : (
          <SuspendButton userId={detail.id} name={name} />
        )
      ) : null}
      {canGrantAdmin(user, detail) ? <GrantAdminButton userId={detail.id} name={name} /> : null}
      {canRevokeAdmin(user, detail) ? <RevokeAdminButton userId={detail.id} name={name} /> : null}
    </>
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title={detail.deletedAt ? "Deleted user" : (detail.name ?? "No name")}
        description={detail.email ?? "No email on file"}
        actions={actions}
      />
      {readOnly ? (
        <p className="text-sm text-muted-foreground">
          Stop viewing as someone to act on this account.
        </p>
      ) : null}

      <Section title="Account">
        <Facts
          items={[
            { label: "User id", value: <code className="text-xs">{detail.id}</code> },
            {
              label: "Status",
              value: detail.deletedAt ? (
                <StatusPill tone="warn">deleted {formatUtc(detail.deletedAt)}</StatusPill>
              ) : detail.status === "suspended" ? (
                <StatusPill tone="bad">suspended</StatusPill>
              ) : (
                <StatusPill tone="good">active</StatusPill>
              ),
            },
            { label: "Roles", value: detail.roles.join(", ") || "None yet" },
            { label: "Active role", value: detail.activeRole ?? "—" },
            { label: "Signed up", value: formatUtc(detail.createdAt) },
            { label: "Onboarding done", value: formatUtc(detail.onboardingCompletedAt) },
            { label: "Signed-in sessions", value: detail.sessionCount },
            {
              label: "Being viewed by an admin",
              value: detail.openImpersonation
                ? `until ${formatUtc(detail.openImpersonation.expiresAt)}`
                : "No",
            },
          ]}
        />
      </Section>

      <Section title="Profiles">
        <Facts
          items={[
            {
              label: "Creator",
              value: detail.creatorProfile ? (
                <Link className="underline" href={`/c/${detail.creatorProfile.handle}`}>
                  @{detail.creatorProfile.handle}
                  {detail.creatorProfile.sizeTier ? ` · ${detail.creatorProfile.sizeTier}` : ""}
                </Link>
              ) : (
                "None"
              ),
            },
            {
              label: "Builder",
              value: detail.builderProfile ? (
                <Link className="underline" href={`/b/${detail.builderProfile.handle}`}>
                  @{detail.builderProfile.handle} · {detail.builderProfile.availability}
                </Link>
              ) : (
                "None"
              ),
            },
          ]}
        />
      </Section>

      {imports?.appStore ? (
        <Section
          title="App Store account"
          description="Verify by hand only after checking the developer account belongs to this builder (for example, a reply from the account's support address)."
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <a
              className="underline"
              href={imports.appStore.developerUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {imports.appStore.developerName ?? "Developer account"}
            </a>
            {imports.appStore.verified ? (
              <StatusPill tone="good">verified</StatusPill>
            ) : readOnly ? null : (
              <VerifyAppStoreButton builderProfileId={imports.builderProfileId} />
            )}
          </div>
        </Section>
      ) : null}

      <Section
        title="Social connections"
        description="Manual entries are typed by the creator; check the screenshot and the profile link before verifying."
      >
        {detail.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No connections.</p>
        ) : (
          <ul className="divide-y">
            {detail.connections.map((connection) => (
              <li
                key={connection.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    {connection.provider} · {connection.username ?? "unknown account"}
                  </p>
                  <p className="text-muted-foreground">
                    {connection.source === "manual" ? "Manual entry" : "Connected"} ·{" "}
                    {connection.status} ·{" "}
                    {connection.verifiedAt
                      ? `verified ${formatUtc(connection.verifiedAt)}`
                      : "unverified"}
                    {connection.lastSyncedAt
                      ? ` · synced ${formatUtc(connection.lastSyncedAt)}`
                      : ""}
                  </p>
                  <p className="flex flex-wrap gap-3">
                    {connection.profileUrl?.startsWith("https://") ? (
                      <a
                        className="underline"
                        href={connection.profileUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                      >
                        Profile link
                      </a>
                    ) : null}
                    {evidenceLinks.get(connection.id) ? (
                      <a
                        className="underline"
                        href={evidenceLinks.get(connection.id) ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Screenshot (link valid 5 minutes)
                      </a>
                    ) : null}
                  </p>
                </div>
                {!readOnly &&
                connection.source === "manual" &&
                connection.verifiedAt === null &&
                connection.status !== "revoked" ? (
                  <VerifyConnectionButton connectionId={connection.id} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Payouts">
        {detail.stripe ? (
          <Facts
            items={[
              { label: "Status", value: PAYOUTS_TEXT[detail.stripe.status.kind] },
              {
                label: "Stripe account",
                value: <code className="text-xs">{detail.stripe.stripeAccountId}</code>,
              },
              { label: "Payouts enabled", value: detail.stripe.payoutsEnabled ? "Yes" : "No" },
              { label: "Details submitted", value: detail.stripe.detailsSubmitted ? "Yes" : "No" },
              { label: "Country", value: detail.stripe.country ?? "—" },
              { label: "Disabled reason", value: detail.stripe.disabledReason ?? "—" },
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No Stripe account yet.</p>
        )}
      </Section>

      <Section title="Collabs">
        {detail.collabs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No collabs.</p>
        ) : (
          <ul className="divide-y">
            {detail.collabs.map((collab) => (
              <li key={collab.id}>
                <Link
                  href={`/admin/collabs/${collab.id}`}
                  className="flex min-h-11 items-center justify-between gap-2 py-2 hover:underline"
                >
                  <span className="min-w-0 break-words">
                    {collab.title} <span className="text-muted-foreground">as {collab.role}</span>
                  </span>
                  <StatusPill>{STAGE_TEXT[collab.stage]}</StatusPill>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Admin actions on this account">
        {audit.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {audit.items.map((row) => (
              <li key={row.id}>
                {formatUtc(row.createdAt)} · {adminAuditActionLabel(row.action)} by {row.adminName}
              </li>
            ))}
          </ul>
        )}
        <Link
          className="inline-flex min-h-11 items-center text-sm underline sm:min-h-0"
          href={`/admin/audit?targetType=user&targetId=${detail.id}`}
        >
          Full audit log for this account
        </Link>
      </Section>
    </div>
  )
}
