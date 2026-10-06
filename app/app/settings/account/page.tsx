import { Download, LogOut, Mail, ShieldCheck, Trash2, UserPlus } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import type { ReactNode } from "react"

import { AccountNameForm } from "@/components/settings/account-name-form"
import { ActiveRoleForm } from "@/components/settings/active-role-form"
import { SignOutEverywhereButton } from "@/components/settings/sign-out-everywhere-button"
import { PageHeader } from "@/components/shared/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { signOutAction } from "@/lib/auth/actions"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { appRolesOf } from "@/lib/auth/user"
import { getDb } from "@/lib/db/client"
import { countSessions } from "@/lib/users/account"

export const metadata: Metadata = { title: "Account" }

/**
 * Settings → Account (§12): name, sign-in email, roles and the active role, sign out (this device
 * or everywhere). "Export my data" and "Delete account" (§14 GDPR) are shown disabled with a note:
 * they arrive with the GDPR work (Phase 6) later in this build (CLAUDE.md §19.17).
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
        {roles.length > 0 ? (
          <ActiveRoleForm
            roles={roles}
            activeRole={roles.find((role) => role === user.activeRole) ?? null}
          />
        ) : null}
        {user.roles.includes("admin") ? (
          <p className="text-sm">
            <Badge variant="outline">Admin</Badge>
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          The active role decides what your home and menu show. You can also switch from the
          sidebar. Roles can be added but not removed.
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

      <Section id="account-sessions" title="Signing out">
        <p className="text-sm text-muted-foreground">
          {sessionCount === 1
            ? "You're signed in on 1 device or browser."
            : `You're signed in on ${sessionCount} devices or browsers.`}{" "}
          If you lost a device or signed in somewhere public, sign out everywhere.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <form action={signOutAction}>
            <Button type="submit" variant="outline" size="sm" className="w-full sm:w-auto">
              <LogOut aria-hidden="true" />
              Sign out
            </Button>
          </form>
          {canManage ? <SignOutEverywhereButton /> : null}
        </div>
      </Section>

      <Section id="account-data" title="Your data">
        <div className="grid gap-3 sm:grid-cols-2">
          <ComingSoonAction
            id="export-data"
            icon={Download}
            label="Export my data"
            description="A copy of your profile, connections and activity as a JSON file."
          />
          <ComingSoonAction
            id="delete-account"
            icon={Trash2}
            label="Delete account"
            destructive
            description="Removes your personal data. Sales records the law requires us to keep stay, without your name or email."
          />
        </div>
        <p className="flex gap-2 text-sm text-muted-foreground">
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
        </p>
      </Section>
    </div>
  )
}

/**
 * A GDPR action that is not built yet (§14, Phase 6): a disabled button with the reason next to
 * it, so people know where it will be.
 */
function ComingSoonAction({
  id,
  icon: Icon,
  label,
  description,
  destructive = false,
}: {
  id: string
  icon: typeof Download
  label: string
  description: string
  destructive?: boolean
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <Button
        type="button"
        variant={destructive ? "destructive" : "outline"}
        size="sm"
        disabled
        aria-describedby={`${id}-note`}
        className="w-full sm:w-fit"
      >
        <Icon aria-hidden="true" />
        {label}
      </Button>
      <p id={`${id}-note`} className="text-sm text-muted-foreground">
        {description} Coming with the data-protection tools later in this build.
      </p>
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
