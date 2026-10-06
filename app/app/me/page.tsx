import {
  ExternalLink,
  Hammer,
  LogOut,
  Megaphone,
  Palette,
  ShieldCheck,
  Smartphone,
  UserPlus,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { MeMenuGroup, MeMenuRow, MeMenuSections } from "@/components/layout/me-menu"
import { ThemeChoice } from "@/components/layout/theme-choice"
import { toShellViewer } from "@/components/layout/viewer"
import { InstallAppButton } from "@/components/pwa/install-prompt"
import { ActiveRoleForm } from "@/components/settings/active-role-form"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { signOutAction } from "@/lib/auth/actions"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { mePageSections, ROLE_LABELS } from "@/lib/nav"
import { loadBuilderProfileForm, loadCreatorProfileForm } from "@/lib/profiles/queries"

export const metadata: Metadata = { title: "Me" }

function initials(name: string | null, email: string): string {
  const parts = (name?.trim() || email).split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?"
}

/**
 * Me (`/app/me`, the phone tab bar's last tab; beyond §12, CLAUDE.md §19): the person, their
 * active role and everything in the app that is not a tab (`mePageSections`: the role's pages,
 * collaboration, inbox, earnings, settings), plus public profile links, the admin area, installing
 * the app, appearance and sign out. With the tabs it makes every app page reachable on a phone
 * without the sidebar. It works on desktop too, where the sidebar lists the same pages.
 */
export default async function MePage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canManageOwnAccount(user))
  const viewer = toShellViewer(user)
  const db = getDb()
  const [creator, builder] = await Promise.all([
    viewer.roles.includes("creator") ? loadCreatorProfileForm(db, user.id) : null,
    viewer.roles.includes("builder") ? loadBuilderProfileForm(db, user.id) : null,
  ])
  const missingRole = viewer.roles.includes("creator") ? "builder" : "creator"
  const hasBothRoles = viewer.roles.includes("creator") && viewer.roles.includes("builder")
  const displayName = user.name?.trim() || user.email

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="flex items-center gap-4">
        <Avatar className="size-14 rounded-2xl">
          {user.image ? <AvatarImage src={user.image} alt="" /> : null}
          <AvatarFallback className="rounded-2xl text-base">
            {initials(user.name, user.email)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{displayName}</h1>
          <p className="truncate text-sm text-muted-foreground">{user.email}</p>
          <div className="flex flex-wrap gap-1">
            <Badge variant="secondary">
              Acting as {ROLE_LABELS[viewer.activeRole].toLowerCase()}
            </Badge>
            {viewer.isAdmin ? <Badge variant="outline">Admin</Badge> : null}
          </div>
        </div>
      </div>

      {viewer.roles.length > 0 ? (
        <section aria-labelledby="me-roles" className="space-y-2">
          <h2
            id="me-roles"
            className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
          >
            Your roles
          </h2>
          <ActiveRoleForm roles={viewer.roles} activeRole={viewer.activeRole} />
          {!hasBothRoles ? (
            <Button asChild variant="outline" className="w-full sm:w-auto">
              <Link href="/onboarding/role">
                <UserPlus aria-hidden="true" />
                Become a {missingRole} too
              </Link>
            </Button>
          ) : null}
        </section>
      ) : null}

      {creator || builder ? (
        <MeMenuGroup label="Your public pages">
          {creator ? (
            <MeMenuRow
              icon={Megaphone}
              title="Creator profile"
              description={`/c/${creator.handle}`}
              href={`/c/${creator.handle}`}
              trailing={
                <ExternalLink
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              }
            />
          ) : null}
          {builder ? (
            <MeMenuRow
              icon={Hammer}
              title="Builder profile"
              description={`/b/${builder.handle}`}
              href={`/b/${builder.handle}`}
              trailing={
                <ExternalLink
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              }
            />
          ) : null}
        </MeMenuGroup>
      ) : null}

      <MeMenuSections sections={mePageSections(viewer.activeRole)} />

      {viewer.isAdmin ? (
        <MeMenuGroup label="Admin">
          <MeMenuRow icon={ShieldCheck} title="Admin area" href="/admin" />
        </MeMenuGroup>
      ) : null}

      <MeMenuGroup label="App">
        <MeMenuRow
          icon={Smartphone}
          title="Install the app"
          description="Open it from your home screen"
          trailing={<InstallAppButton />}
        />
        <li className="space-y-3 px-3 py-3">
          <div className="flex items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Palette className="size-4" aria-hidden="true" />
            </span>
            <span className="text-sm font-medium">Appearance</span>
          </div>
          <ThemeChoice />
        </li>
      </MeMenuGroup>

      <form action={signOutAction}>
        <Button type="submit" variant="outline" size="lg" className="w-full">
          <LogOut aria-hidden="true" />
          Sign out
        </Button>
      </form>
    </div>
  )
}
