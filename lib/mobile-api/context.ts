import "server-only"

import { AsyncLocalStorage } from "node:async_hooks"

import { eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"

import { appRolesOf, type AuthUser } from "@/lib/auth/user"
import type { DbOrTx } from "@/lib/db/client"
import { builderProfiles, creatorProfiles } from "@/lib/db/schema"
import { env, isProduction } from "@/lib/env"
import { countUnreadNotifications } from "@/lib/notifications/center"
import { resolveOnboardingRedirect } from "@/lib/onboarding/gate"
import { countUnreadMessages } from "@/lib/threads/queries"

import type { AppRole, Me } from "./schemas"

/** Helpers shared by the mobile endpoints (CLAUDE.md §19.44). */

/** The role the app acts as: the active one when it is an app role, else the first app role. */
export function activeAppRole(user: AuthUser): AppRole | null {
  const roles = appRolesOf(user)
  return roles.find((role) => role === user.activeRole) ?? roles[0] ?? null
}

const requestOrigin = new AsyncLocalStorage<string>()

/**
 * The origin the phone reached this server at, outside production only: a phone talking to the
 * desktop app or `pnpm dev` through a tunnel cannot open `NEXT_PUBLIC_APP_URL` (localhost), so
 * links and images point back at the address it used. Production always uses the configured URL.
 */
export function publicOriginOf(request: Request): string | null {
  if (isProduction()) return null
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host")
  if (!host || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return null
  const forwarded = request.headers.get("x-forwarded-proto")
  const proto =
    forwarded === "http" || forwarded === "https"
      ? forwarded
      : new URL(request.url).protocol.replace(":", "")
  return `${proto === "http" ? "http" : "https"}://${host}`
}

export function withRequestOrigin<T>(origin: string | null, fn: () => Promise<T>): Promise<T> {
  return origin ? requestOrigin.run(origin, fn) : fn()
}

/** The web app's absolute URL of a path (links the native app opens in Safari). */
export function webUrl(path = "/"): string {
  return new URL(path, requestOrigin.getStore() ?? env.NEXT_PUBLIC_APP_URL).toString()
}

/** Web pages that show what a mobile change touched; the web's actions revalidate the same. */
export function revalidateApp(): void {
  revalidatePath("/app", "layout")
}

export async function buildMe(db: DbOrTx, user: AuthUser): Promise<Me> {
  const [step, creator, builder, notifications, messages] = await Promise.all([
    resolveOnboardingRedirect(user, db),
    db
      .select({ handle: creatorProfiles.handle, displayName: creatorProfiles.displayName })
      .from(creatorProfiles)
      .where(eq(creatorProfiles.userId, user.id)),
    db
      .select({ handle: builderProfiles.handle, displayName: builderProfiles.displayName })
      .from(builderProfiles)
      .where(eq(builderProfiles.userId, user.id)),
    countUnreadNotifications(db, user.id),
    countUnreadMessages(db, user.id),
  ])
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles: [...user.roles],
    activeRole: user.activeRole,
    // The gate may just have finished onboarding (facts alone), so read the answer, not the row.
    onboarded: step === null,
    onboardingUrl: step ? webUrl(step) : null,
    profiles: { creator: creator[0] ?? null, builder: builder[0] ?? null },
    unread: { notifications, messages },
    webUrl: webUrl("/"),
  }
}
