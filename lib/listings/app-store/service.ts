import "server-only"

import { createHmac } from "node:crypto"

import { and, asc, eq, gt, isNotNull, isNull, lt, ne, or } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import type { ClaudeDeps } from "@/lib/ai/claude"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { builderProfiles, users } from "@/lib/db/schema"
import { env } from "@/lib/env"
import { track } from "@/lib/events/track"
import type { NetTransport } from "@/lib/net/safe-fetch"
import type { ObjectStorage } from "@/lib/storage/types"

import { markRemovedAppStoreListings, saveListingDrafts, type ListingWriteResult } from "../store"
import { listingTransport } from "../transport"
import { APP_STORE_INPUT_MESSAGE, parseAppStoreInput, storefront, type AppStoreInput } from "./link"
import {
  appStoreLookup,
  AppStoreLookupError,
  idString,
  isAppleImageHost,
  type AppStoreApp,
  type LookupResult,
} from "./lookup"
import { appToDraft } from "./mapping"

/**
 * App Store developer accounts on builder profiles (CLAUDE.md §19.45).
 *
 * - **Connect:** the builder pastes a developer link, an app link or an id. We look the developer
 *   up (an app link → its `artistId`), store the account on the builder profile (unverified) and
 *   import every app as a published listing.
 * - **Sync:** the same import again (Refresh button, daily job): new apps are added, changed ones
 *   updated (builder edits kept), apps no longer in the store are hidden (`source_removed_at`).
 * - **Verify (decided here):** a builder proves the account is theirs by putting a short code
 *   (`appStoreVerificationCode`, derived from the profile and the developer id) in the
 *   description of any of their apps; "Check" finds it through the public lookup. Admins can
 *   verify by hand instead. A seller or developer name is public, so matching a name proves
 *   nothing; until verified, pages say "Unverified". One builder per verified developer account.
 */

export const MAX_APPS_PER_IMPORT = 40

export const APP_STORE_MESSAGES = {
  notFound: "We couldn't find that developer on the App Store. Check the link and try again.",
  unavailable: "The App Store isn't answering right now. Try again in a few minutes.",
  takenVerified: "Another builder has already verified this developer account.",
  noAccount: "Connect your App Store developer account first.",
  noProfile: "Create your builder profile first.",
  codeMissing:
    "We didn't find the code in any of your apps' descriptions yet. App Store changes can take a few hours to show up.",
} as const

export type AppStoreDeps = {
  transport?: NetTransport
  storage?: ObjectStorage
  ai?: ClaudeDeps
}

export type AppStoreSyncSummary = {
  developerId: string
  developerName: string
  apps: number
  created: number
  updated: number
  removed: number
  listings: ListingWriteResult[]
}

/** The code a builder puts in an app description to verify the account (8 characters). */
export function appStoreVerificationCode(builderProfileId: string, developerId: string): string {
  const digest = createHmac("sha256", env.AUTH_SECRET)
    .update(`vincera/app-store-verify/v1:${builderProfileId}:${developerId}`)
    .digest()
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
  let code = ""
  for (let i = 0; i < 8; i += 1) code += alphabet[(digest[i] ?? 0) % alphabet.length]
  return `VNC-${code}`
}

function lookupError(error: unknown): never {
  if (error instanceof AppStoreLookupError) throw new ActionError(APP_STORE_MESSAGES.unavailable)
  throw error
}

/** The developer and their apps, most-rated first, at most MAX_APPS_PER_IMPORT. */
async function lookupDeveloper(
  developerId: string,
  country: string,
  transport: NetTransport,
): Promise<LookupResult> {
  const result = await appStoreLookup({ id: developerId, country, software: true }, transport)
  const apps = result.apps
    .filter((app) => idString(app.artistId) === developerId)
    .sort((a, b) => (b.userRatingCount ?? 0) - (a.userRatingCount ?? 0))
    .slice(0, MAX_APPS_PER_IMPORT)
  return { artist: result.artist, apps }
}

/** Resolve what the builder pasted to a developer id (an app link → its developer). */
async function resolveDeveloper(
  input: AppStoreInput,
  transport: NetTransport,
): Promise<{ developerId: string; country: string }> {
  const country = storefront(input.country)
  if (input.kind === "developer") return { developerId: input.id, country }
  const found = await appStoreLookup({ id: input.id, country, software: false }, transport)
  const app = found.apps[0]
  if (!app) throw new ActionError(APP_STORE_MESSAGES.notFound, { fieldErrors: { appStore: [APP_STORE_MESSAGES.notFound] } })
  return { developerId: idString(app.artistId), country }
}

type ProfileRow = {
  id: string
  userId: string
  appStoreDeveloperId: string | null
  appStoreCountry: string | null
  appStoreVerifiedAt: Date | null
}

async function builderProfileOf(database: DbOrTx, userId: string): Promise<ProfileRow> {
  const [profile] = await database
    .select({
      id: builderProfiles.id,
      userId: builderProfiles.userId,
      appStoreDeveloperId: builderProfiles.appStoreDeveloperId,
      appStoreCountry: builderProfiles.appStoreCountry,
      appStoreVerifiedAt: builderProfiles.appStoreVerifiedAt,
    })
    .from(builderProfiles)
    .where(eq(builderProfiles.userId, userId))
    .limit(1)
  if (!profile) throw new ActionError(APP_STORE_MESSAGES.noProfile)
  return profile
}

async function verifiedElsewhere(
  database: DbOrTx,
  developerId: string,
  builderProfileId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: builderProfiles.id })
    .from(builderProfiles)
    .where(
      and(
        eq(builderProfiles.appStoreDeveloperId, developerId),
        isNotNull(builderProfiles.appStoreVerifiedAt),
        ne(builderProfiles.id, builderProfileId),
      ),
    )
    .limit(1)
  return row !== undefined
}

async function importApps(
  database: DbOrTx,
  input: {
    builderProfileId: string
    actorUserId: string | null
    apps: readonly AppStoreApp[]
    country: string
    trigger: "connected" | "manual" | "scheduled"
    developerId: string
    developerName: string
  },
  deps: AppStoreDeps & { transport: NetTransport },
): Promise<AppStoreSyncSummary> {
  const listings = await saveListingDrafts(database, {
    builderProfileId: input.builderProfileId,
    actorUserId: input.actorUserId,
    drafts: input.apps.map((app) => appToDraft(app, input.country)),
    transport: deps.transport,
    allowImageHost: isAppleImageHost,
    storage: deps.storage,
    ai: deps.ai,
  })
  const removed = await markRemovedAppStoreListings(database, {
    builderProfileId: input.builderProfileId,
    presentIds: input.apps.map((app) => idString(app.trackId)),
    actorUserId: input.actorUserId,
  })
  const summary: AppStoreSyncSummary = {
    developerId: input.developerId,
    developerName: input.developerName,
    apps: input.apps.length,
    created: listings.filter((l) => l.action === "created").length,
    updated: listings.filter((l) => l.action === "updated").length,
    removed: removed.length,
    listings,
  }
  await withTransaction(async (tx) => {
    await tx
      .update(builderProfiles)
      .set({ appStoreSyncedAt: now(), appStoreSyncError: null })
      .where(eq(builderProfiles.id, input.builderProfileId))
    await track(
      "app_store.synced",
      {
        actorUserId: input.actorUserId,
        subjectType: "builder_profile",
        subjectId: input.builderProfileId,
        properties: {
          trigger: input.trigger,
          created: summary.created,
          updated: summary.updated,
          removed: summary.removed,
        },
      },
      tx,
    )
  }, database)
  return summary
}

/** Connect (or switch) the builder's App Store developer account and import its apps. */
export async function connectAppStore(
  database: DbOrTx,
  input: { userId: string; raw: string },
  deps: AppStoreDeps = {},
): Promise<AppStoreSyncSummary> {
  const parsed = parseAppStoreInput(input.raw)
  if (!parsed) {
    throw new ActionError(APP_STORE_INPUT_MESSAGE, {
      fieldErrors: { appStore: [APP_STORE_INPUT_MESSAGE] },
    })
  }
  const transport = deps.transport ?? listingTransport("appstore")
  const profile = await builderProfileOf(database, input.userId)

  const { developerId, country } = await resolveDeveloper(parsed, transport).catch(lookupError)
  const found = await lookupDeveloper(developerId, country, transport).catch(lookupError)
  const developerName = found.artist?.artistName ?? found.apps[0]?.artistName
  if (!developerName) {
    throw new ActionError(APP_STORE_MESSAGES.notFound, {
      fieldErrors: { appStore: [APP_STORE_MESSAGES.notFound] },
    })
  }
  if (await verifiedElsewhere(database, developerId, profile.id)) {
    throw new ActionError(APP_STORE_MESSAGES.takenVerified, {
      fieldErrors: { appStore: [APP_STORE_MESSAGES.takenVerified] },
    })
  }

  await withTransaction(async (tx) => {
    const [locked] = await tx
      .select({ developerId: builderProfiles.appStoreDeveloperId })
      .from(builderProfiles)
      .where(eq(builderProfiles.id, profile.id))
      .for("update")
    const switching = locked?.developerId !== developerId
    await tx
      .update(builderProfiles)
      .set({
        appStoreDeveloperId: developerId,
        appStoreDeveloperName: developerName.slice(0, 120),
        appStoreCountry: country,
        appStoreSyncError: null,
        // Another account starts unverified.
        ...(switching ? { appStoreVerifiedAt: null, appStoreVerificationMethod: null } : {}),
      })
      .where(eq(builderProfiles.id, profile.id))
    await track(
      "app_store.connected",
      {
        actorUserId: input.userId,
        subjectType: "builder_profile",
        subjectId: profile.id,
        properties: {
          via:
            parsed.kind === "app"
              ? "app_link"
              : /^(id)?\d+$/i.test(input.raw.trim())
                ? "id"
                : "developer_link",
          app_count: found.apps.length,
        },
      },
      tx,
    )
  }, database)

  return importApps(
    database,
    {
      builderProfileId: profile.id,
      actorUserId: input.userId,
      apps: found.apps,
      country,
      trigger: "connected",
      developerId,
      developerName,
    },
    { ...deps, transport },
  )
}

/**
 * Import the connected account again (Refresh, daily job). Lookup failures are recorded on the
 * profile (`app_store_sync_error`) and returned as null; listings are never removed because the
 * App Store did not answer.
 */
export async function syncAppStore(
  database: DbOrTx,
  input: {
    builderProfileId: string
    actorUserId: string | null
    trigger: "manual" | "scheduled"
  },
  deps: AppStoreDeps = {},
): Promise<AppStoreSyncSummary | { error: "not_connected" | "not_found" | "unavailable" }> {
  const [profile] = await database
    .select({
      developerId: builderProfiles.appStoreDeveloperId,
      country: builderProfiles.appStoreCountry,
      developerName: builderProfiles.appStoreDeveloperName,
    })
    .from(builderProfiles)
    .where(eq(builderProfiles.id, input.builderProfileId))
    .limit(1)
  if (!profile?.developerId || !profile.country) return { error: "not_connected" }
  const transport = deps.transport ?? listingTransport("appstore")

  const recordError = async (code: "not_found" | "unavailable") => {
    await database
      .update(builderProfiles)
      .set({ appStoreSyncError: code })
      .where(eq(builderProfiles.id, input.builderProfileId))
    return { error: code }
  }

  let found: LookupResult
  try {
    found = await lookupDeveloper(profile.developerId, profile.country, transport)
  } catch (error) {
    if (error instanceof AppStoreLookupError) return recordError("unavailable")
    throw error
  }
  if (!found.artist && found.apps.length === 0) return recordError("not_found")

  return importApps(
    database,
    {
      builderProfileId: input.builderProfileId,
      actorUserId: input.actorUserId,
      apps: found.apps,
      country: profile.country,
      trigger: input.trigger,
      developerId: profile.developerId,
      developerName: found.artist?.artistName ?? profile.developerName ?? "",
    },
    { ...deps, transport },
  )
}

/** Check the builder's apps for their verification code; verify the account when found. */
export async function checkAppStoreVerification(
  database: DbOrTx,
  input: { userId: string },
  deps: AppStoreDeps = {},
): Promise<{ verified: boolean; alreadyVerified: boolean }> {
  const profile = await builderProfileOf(database, input.userId)
  if (!profile.appStoreDeveloperId || !profile.appStoreCountry) {
    throw new ActionError(APP_STORE_MESSAGES.noAccount)
  }
  if (profile.appStoreVerifiedAt) return { verified: true, alreadyVerified: true }
  const developerId = profile.appStoreDeveloperId
  const code = appStoreVerificationCode(profile.id, developerId)
  const transport = deps.transport ?? listingTransport("appstore")
  const found = await lookupDeveloper(developerId, profile.appStoreCountry, transport).catch(
    lookupError,
  )
  const hasCode = found.apps.some((app) => (app.description ?? "").includes(code))
  if (!hasCode) return { verified: false, alreadyVerified: false }
  await markAppStoreVerified(database, {
    builderProfileId: profile.id,
    developerId,
    method: "description_code",
    actorUserId: input.userId,
  })
  return { verified: true, alreadyVerified: false }
}

/** Set the verification (code found, or an admin's check), at most one builder per account. */
export async function markAppStoreVerified(
  database: DbOrTx,
  input: {
    builderProfileId: string
    developerId: string
    method: "description_code" | "admin"
    actorUserId: string
  },
  audit?: (tx: Tx) => Promise<void>,
): Promise<void> {
  await withTransaction(async (tx) => {
    const [locked] = await tx
      .select({
        developerId: builderProfiles.appStoreDeveloperId,
        verifiedAt: builderProfiles.appStoreVerifiedAt,
      })
      .from(builderProfiles)
      .where(eq(builderProfiles.id, input.builderProfileId))
      .for("update")
    if (!locked || locked.developerId !== input.developerId) {
      throw new ActionError(APP_STORE_MESSAGES.noAccount)
    }
    if (locked.verifiedAt) return
    if (await verifiedElsewhere(tx, input.developerId, input.builderProfileId)) {
      throw new ActionError(APP_STORE_MESSAGES.takenVerified)
    }
    await tx
      .update(builderProfiles)
      .set({ appStoreVerifiedAt: now(), appStoreVerificationMethod: input.method })
      .where(eq(builderProfiles.id, input.builderProfileId))
    await track(
      "app_store.verified",
      {
        actorUserId: input.actorUserId,
        subjectType: "builder_profile",
        subjectId: input.builderProfileId,
        properties: { method: input.method },
      },
      tx,
    )
    await audit?.(tx)
  }, database)
}

/** Forget the account (listings stay: the builder archives what they no longer want shown). */
export async function disconnectAppStore(
  database: DbOrTx,
  input: { userId: string },
): Promise<void> {
  const profile = await builderProfileOf(database, input.userId)
  if (!profile.appStoreDeveloperId) return
  await withTransaction(async (tx) => {
    await tx
      .update(builderProfiles)
      .set({
        appStoreDeveloperId: null,
        appStoreDeveloperName: null,
        appStoreCountry: null,
        appStoreVerifiedAt: null,
        appStoreVerificationMethod: null,
        appStoreSyncedAt: null,
        appStoreSyncError: null,
      })
      .where(eq(builderProfiles.id, profile.id))
    await track(
      "app_store.disconnected",
      {
        actorUserId: input.userId,
        subjectType: "builder_profile",
        subjectId: profile.id,
        properties: {},
      },
      tx,
    )
  }, database)
}

/** Builders the daily job re-imports: connected, active, not synced since `cutoff`. */
export async function dueAppStoreProfiles(
  database: DbOrTx,
  input: { cutoff: Date; afterId: string | null; limit: number },
): Promise<string[]> {
  const rows = await database
    .select({ id: builderProfiles.id })
    .from(builderProfiles)
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(
      and(
        isNotNull(builderProfiles.appStoreDeveloperId),
        eq(users.status, "active"),
        isNull(users.deletedAt),
        or(isNull(builderProfiles.appStoreSyncedAt), lt(builderProfiles.appStoreSyncedAt, input.cutoff)),
        input.afterId ? gt(builderProfiles.id, input.afterId) : undefined,
      ),
    )
    .orderBy(asc(builderProfiles.id))
    .limit(input.limit)
  return rows.map((row) => row.id)
}
