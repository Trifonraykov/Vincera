import { Download, Mail, ShieldCheck, Trash2, UserPlus } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import type { ReactNode } from "react"

import { AccountNameForm } from "@/components/settings/account-name-form"
import { SignOutEverywhereButton } from "@/components/settings/sign-out-everywhere-button"
import { PageHeader } from "@/components/shared/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { appRolesOf } from "@/lib/auth/user"
import { getDb } from "@/lib/db/client"
import { ROLE_LABELS } from "@/lib/nav"
import { countSessions } from "@/lib/users/account"

export const metadata: Metadata = { title: "Account" }

/**
 * Settings → Account (§12): name, sign-in email, roles, sessions. Data export and account deletion
 * (§14 GDPR) are Phase 6; this page says so instead of offering a button that does nothing.
 */
export default async function AccountSettingsPage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const canManage = canManageOwnAccount(user)
  const roles = appRolesOf(user)
  const sessionCount = await countSessions(getDb(), user.id)
  const missingRole = roles.includes("creator") ? "builder" : "creator"
  const hasBothRoles = roles.includes("creator") && roles.includes("builder")

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader
        title="Account"
        description="How you sign in, and what you use the platform as."
      />

      <Section id="account-name" title="Name">
        {canManage ? <AccountNameForm name={user.name ?? ""} /> : null}
      </Section>

      <Section id="account-email" title="Sign-in email">
        <p className="flex items-center gap-2 text-sm">
          <Mail className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium break-all">{user.email}</span>
        </p>
        <p className="text-sm text-muted-foreground">
          We send sign-in links and notifications here. Changing it isn&apos;t possible yet.
        </p>
      </Section>

      <Section id="account-roles" title="Roles">
        <div className="flex flex-wrap gap-2">
          {roles.map((role) => (
            <Badge key={role} variant={role === user.activeRole ? "default" : "secondary"}>
              {ROLE_LABELS[role]}
              {role === user.activeRole ? <span className="sr-only"> (active)</span> : null}
            </Badge>
          ))}
          {user.roles.includes("admin") ? <Badge variant="outline">Admin</Badge> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Switch between your roles from the sidebar. Roles can be added but not removed.
        </p>
        {!hasBothRoles ? (
          <Button asChild variant="outline" size="sm">
            <Link href="/onboarding/role">
              <UserPlus aria-hidden="true" />
              Become a {missingRole} too
            </Link>
          </Button>
        ) : null}
      </Section>

      <Section id="account-sessions" title="Signed-in devices">
        <p className="text-sm text-muted-foreground">
          {sessionCount === 1
            ? "You're signed in on 1 device or browser."
            : `You're signed in on ${sessionCount} devices or browsers.`}{" "}
          If you lost a device or signed in somewhere public, sign out everywhere.
        </p>
        {canManage ? <SignOutEverywhereButton /> : null}
      </Section>

      <Section id="account-data" title="Your data">
        <ul className="space-y-3 text-sm text-muted-foreground">
          <li className="flex gap-3">
            <Download className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-medium text-foreground">Download your data.</span> A copy of
              your profile, connections and activity as a file. Coming soon to this page.
            </span>
          </li>
          <li className="flex gap-3">
            <Trash2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-medium text-foreground">Delete your account.</span> Removes your
              personal data. Sales records the law requires us to keep stay, without your name or
              email. Coming soon to this page.
            </span>
          </li>
          <li className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              Disconnecting an account in{" "}
              <Link
                href="/app/settings/connections"
                className="font-medium text-foreground underline"
              >
                Connections
              </Link>{" "}
              already deletes its access and every stat we stored from it. See our{" "}
              <Link href="/legal/privacy" className="font-medium text-foreground underline">
                privacy policy
              </Link>
              .
            </span>
          </li>
        </ul>
      </Section>
    </div>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3 rounded-xl border bg-card p-5 shadow-xs">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}
