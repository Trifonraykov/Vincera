import "server-only"

import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"

import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { accessGrants, launches, launchFiles, licenseKeys, orders } from "@/lib/db/schema"
import type { DeliveryType } from "@/lib/db/schema/enums"
import { track } from "@/lib/events/track"
import { parseDeliveryConfig } from "@/lib/launches/fields"
import { assignLicenseKey } from "@/lib/orders/license-keys"
import { getStorage } from "@/lib/storage/r2"
import type { ObjectStorage } from "@/lib/storage/types"

import { isAccessToken } from "./token"

/**
 * Buyer access (§12 `/access/[token]`; CLAUDE.md §19.31 "Access", §19.34). The token is the
 * buyer's only key: an unknown or malformed one is a 404, a revoked grant (full refund, lost
 * chargeback) shows a plain "no longer available" page, and a working one delivers:
 *
 * - `file`: the launch's files, each downloaded through `/access/<token>/files/<fileId>`, which
 *   answers 302 to a 5-minute signed storage URL (made per click, so a page left open never holds
 *   an expired link);
 * - `license_key`: the order's key; when the launch ran out at payment time and keys were added
 *   since, the next one is assigned on the visit (`claimWaitingLicenseKey`);
 * - `url`: a redirect to `delivery_config.url`.
 */

export const ACCESS_FILE_URL_TTL_SECONDS = 5 * 60
/** `access` bucket (§19.31): per IP. */
export const ACCESS_RATE_LIMIT = { limit: 60, window: "1 m" } as const

export type AccessFile = { id: string; filename: string; sizeBytes: number }

export type AccessView =
  | { status: "revoked"; launchTitle: string; slug: string }
  | {
      status: "active"
      orderId: string
      launchId: string
      launchTitle: string
      slug: string
      paidAt: Date
      deliveryType: DeliveryType
      files: AccessFile[]
      licenseKey: string | null
      instructions: string | null
      url: string | null
    }

type Grant = {
  orderId: string
  revokedAt: Date | null
  launchId: string
  launchTitle: string
  slug: string
  deliveryType: DeliveryType | null
  deliveryConfig: unknown
  paidAt: Date
}

async function loadGrant(database: DbOrTx, token: string): Promise<Grant | null> {
  if (!isAccessToken(token)) return null
  const [row] = await database
    .select({
      orderId: accessGrants.orderId,
      revokedAt: accessGrants.revokedAt,
      launchId: launches.id,
      launchTitle: launches.title,
      slug: launches.slug,
      deliveryType: launches.deliveryType,
      deliveryConfig: launches.deliveryConfig,
      paidAt: orders.paidAt,
    })
    .from(accessGrants)
    .innerJoin(orders, eq(orders.id, accessGrants.orderId))
    .innerJoin(launches, eq(launches.id, orders.launchId))
    .where(eq(accessGrants.token, token))
  return row ?? null
}

export async function loadAccessView(database: DbOrTx, token: string): Promise<AccessView | null> {
  const grant = await loadGrant(database, token)
  if (!grant || !grant.deliveryType) return null
  if (grant.revokedAt) {
    return { status: "revoked", launchTitle: grant.launchTitle, slug: grant.slug }
  }

  const config = parseDeliveryConfig(grant.deliveryConfig)
  let files: AccessFile[] = []
  let licenseKey: string | null = null
  if (grant.deliveryType === "file") {
    files = await database
      .select({
        id: launchFiles.id,
        filename: launchFiles.filename,
        sizeBytes: launchFiles.sizeBytes,
      })
      .from(launchFiles)
      .where(eq(launchFiles.launchId, grant.launchId))
      .orderBy(asc(launchFiles.position), asc(launchFiles.createdAt), asc(launchFiles.id))
  } else if (grant.deliveryType === "license_key") {
    licenseKey =
      (await orderLicenseKey(database, grant.orderId)) ??
      (await claimWaitingLicenseKey(database, grant.orderId, grant.launchId))
  }
  return {
    status: "active",
    orderId: grant.orderId,
    launchId: grant.launchId,
    launchTitle: grant.launchTitle,
    slug: grant.slug,
    paidAt: grant.paidAt,
    deliveryType: grant.deliveryType,
    files,
    licenseKey,
    instructions: config?.type === "license_key" ? (config.instructions ?? null) : null,
    url: config?.type === "url" ? config.url : null,
  }
}

async function orderLicenseKey(database: DbOrTx, orderId: string): Promise<string | null> {
  const [row] = await database
    .select({ key: licenseKeys.key })
    .from(licenseKeys)
    .where(eq(licenseKeys.orderId, orderId))
  return row?.key ?? null
}

/**
 * An order that paid while the launch was out of keys gets the next key added since. The order row
 * is locked first, so two visits at once assign one key, not two.
 */
export async function claimWaitingLicenseKey(
  database: DbOrTx,
  orderId: string,
  launchId: string,
): Promise<string | null> {
  return withTransaction(async (tx) => {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update")
    const existing = await orderLicenseKey(tx, orderId)
    if (existing) return existing
    if (!(await assignLicenseKey(tx, launchId, orderId, now()))) return null
    return orderLicenseKey(tx, orderId)
  }, database)
}

/** `access.opened` (actor null: buyers have no account; never the token or the email). */
export async function recordAccessOpened(
  database: DbOrTx,
  view: Extract<AccessView, { status: "active" }>,
  context: { ipCountry: string | null; uaHash: string | null },
): Promise<void> {
  await track(
    "access.opened",
    {
      actorUserId: null,
      subjectType: "order",
      subjectId: view.orderId,
      properties: { launch_id: view.launchId, delivery_type: view.deliveryType },
      context: { ip_country: context.ipCountry, ua_hash: context.uaHash },
    },
    database,
  )
}

/**
 * A 5-minute download URL for one file of the grant's launch, or null (unknown or revoked token,
 * not a file delivery, or a file of another launch).
 */
export async function accessFileUrl(
  database: DbOrTx,
  token: string,
  fileId: string,
  storage: ObjectStorage = getStorage(),
): Promise<string | null> {
  const grant = await loadGrant(database, token)
  if (!grant || grant.revokedAt || grant.deliveryType !== "file") return null
  if (!z.uuid().safeParse(fileId).success) return null
  const [file] = await database
    .select({ storageKey: launchFiles.storageKey, filename: launchFiles.filename })
    .from(launchFiles)
    .where(and(eq(launchFiles.id, fileId), eq(launchFiles.launchId, grant.launchId)))
  if (!file) return null
  return storage.signedGetUrl(file.storageKey, {
    expiresInSeconds: ACCESS_FILE_URL_TTL_SECONDS,
    filename: file.filename,
  })
}
