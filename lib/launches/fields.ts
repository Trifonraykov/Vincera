import { z } from "zod"

import type { DeliveryConfig, LaunchMedia } from "@/lib/db/schema"
import type { DeliveryType, LaunchStatus } from "@/lib/db/schema/enums"
import { parseMoneyInput } from "@/lib/money-input"
import { normalizeMimeType, UPLOAD_LIMITS, validateUpload } from "@/lib/storage/limits"
import {
  collapseLine,
  normalizeMultiline,
  optionalLine,
  optionalLongText,
} from "@/lib/supply/fields"

/**
 * Launch setup fields (§5 launches, §12 "Launch setup page"; CLAUDE.md §19.31, §19.32). Client-safe:
 * the setup form, the server actions and the tests share these rules.
 */

export const LAUNCH_CURRENCY = "eur"
export const LAUNCH_TITLE_MAX = 120
export const LAUNCH_TAGLINE_MAX = 140
export const LAUNCH_DESCRIPTION_MAX = 10_000
/** The database allows 50–1,000,000 cents: Stripe's EUR minimum and the platform's ceiling. */
export const LAUNCH_PRICE_MIN_CENTS = 50
export const LAUNCH_PRICE_MAX_CENTS = 1_000_000
export const LAUNCH_URL_MAX = 2000
export const LAUNCH_INSTRUCTIONS_MAX = 1000
export const SLUG_MIN = 3
export const SLUG_MAX = 80
export const LAUNCH_FILES_MAX = 20
export const LAUNCH_MEDIA_MAX = 6
export const MEDIA_ALT_MAX = 200
export const LICENSE_KEY_MAX = 200
export const LICENSE_KEYS_PER_BATCH = 1000
export const REVIEW_NOTE_MAX = 1000

export const DELIVERY_TYPES = ["file", "license_key", "url"] as const satisfies DeliveryType[]

export const DELIVERY_TYPE_LABELS: Record<DeliveryType, { title: string; description: string }> = {
  file: { title: "Files", description: "Buyers download files you upload." },
  license_key: {
    title: "License keys",
    description: "Each buyer gets one key from a list you add.",
  },
  url: { title: "A link", description: "Buyers are sent to a page, e.g. your app's sign-up." },
}

/** What buyers see under the price (§7.2: the platform is the seller and Stripe Tax adds VAT). */
export const PRICE_TAX_NOTE = "Price includes VAT where it applies."

// --- Slugs ----------------------------------------------------------------------------------

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** "Budget Tracker für Studenten!" → "budget-tracker-fur-studenten" (≤ 80, may be empty). */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (slug.length <= SLUG_MAX) return slug
  return slug.slice(0, SLUG_MAX).replace(/-+[^-]*$/, "") || slug.slice(0, SLUG_MAX)
}

export function isValidSlug(value: string): boolean {
  return value.length >= SLUG_MIN && value.length <= SLUG_MAX && SLUG_PATTERN.test(value)
}

/** A base for a new launch's slug: the title's slug, padded when too short. */
export function baseSlug(title: string): string {
  const slug = slugify(title)
  if (slug.length >= SLUG_MIN) return slug
  return slug ? `${slug}-launch` : "launch"
}

/** Candidates for a free slug: `base`, `base-2`, …, each within 80 characters. */
export function slugCandidates(base: string, count = 10): string[] {
  const candidates = [base]
  for (let n = 2; candidates.length < count; n += 1) {
    const suffix = `-${n}`
    candidates.push(`${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`)
  }
  return candidates
}

const SLUG_MESSAGE = `Use ${SLUG_MIN}–${SLUG_MAX} lowercase letters, digits and dashes, like budget-tracker.`

/** The slug field: typed text is turned into a slug (spaces → dashes, lowercase). */
export const slugSchema = z
  .string({ error: SLUG_MESSAGE })
  .transform((value) => slugify(value))
  .pipe(z.string().refine(isValidSlug, SLUG_MESSAGE))

// --- Price ----------------------------------------------------------------------------------

/** A price typed in euros → integer cents (50–1,000,000), or null when empty (drafts). */
export const launchPriceSchema = z
  .union([z.string().max(40), z.number()])
  .optional()
  .transform((value, context) => {
    const invalid = (message: string) => {
      context.addIssue({ code: "custom", message })
      return z.NEVER
    }
    let cents: number | null
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) return invalid("Enter a price like 19 or 19.99.")
      cents = value
    } else {
      const parsed = parseMoneyInput(value ?? "", {
        currency: LAUNCH_CURRENCY,
        max: LAUNCH_PRICE_MAX_CENTS,
      })
      if (!parsed.ok) {
        return invalid(
          parsed.reason === "too_large"
            ? "Keep the price at €10,000 or less."
            : parsed.reason === "too_many_decimals"
              ? "Use at most two decimals, like 19.99."
              : "Enter a price like 19 or 19.99.",
        )
      }
      cents = parsed.cents
    }
    if (cents === null) return null
    if (cents < LAUNCH_PRICE_MIN_CENTS) return invalid("The lowest price is €0.50.")
    if (cents > LAUNCH_PRICE_MAX_CENTS) return invalid("Keep the price at €10,000 or less.")
    return cents
  })

// --- Delivery URL ---------------------------------------------------------------------------

/** An https URL buyers are sent to (`https://` added when missing); null when empty. */
export const deliveryUrlSchema = z
  .string()
  .max(LAUNCH_URL_MAX, "That link is too long.")
  .optional()
  .transform((value, context) => {
    const text = (value ?? "").trim()
    if (text === "") return null
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
    let url: URL
    try {
      url = new URL(withScheme)
    } catch {
      context.addIssue({ code: "custom", message: "Enter a link like https://app.example.com." })
      return z.NEVER
    }
    if (url.protocol !== "https:" || !url.hostname.includes(".")) {
      context.addIssue({ code: "custom", message: "Use an https:// link." })
      return z.NEVER
    }
    return url.toString()
  })

// --- The setup form -------------------------------------------------------------------------

const deliveryTypeSchema = z
  .union([z.enum(DELIVERY_TYPES), z.literal("")])
  .optional()
  .transform((value) => (value ? value : null))

export const launchFormSchema = z.object({
  title: z
    .string({ error: "Give your launch a title." })
    .transform(collapseLine)
    .pipe(
      z
        .string()
        .min(1, "Give your launch a title.")
        .max(LAUNCH_TITLE_MAX, `Keep the title under ${LAUNCH_TITLE_MAX} characters.`),
    ),
  tagline: optionalLine(
    LAUNCH_TAGLINE_MAX,
    `Keep the tagline under ${LAUNCH_TAGLINE_MAX} characters.`,
  ),
  descriptionMd: optionalLongText(
    LAUNCH_DESCRIPTION_MAX,
    `Keep the description under ${LAUNCH_DESCRIPTION_MAX.toLocaleString("en-US")} characters.`,
  ),
  price: launchPriceSchema,
  slug: slugSchema,
  deliveryType: deliveryTypeSchema,
  deliveryUrl: deliveryUrlSchema,
  instructions: optionalLongText(
    LAUNCH_INSTRUCTIONS_MAX,
    `Keep the instructions under ${LAUNCH_INSTRUCTIONS_MAX.toLocaleString("en-US")} characters.`,
  ),
})
export type LaunchFormInput = z.input<typeof launchFormSchema>
export type LaunchFields = z.output<typeof launchFormSchema>

/** Form field names (for "is there a field to show this error next to"). */
export const LAUNCH_FIELD_NAMES = [
  "title",
  "tagline",
  "descriptionMd",
  "price",
  "slug",
  "deliveryType",
  "deliveryUrl",
  "instructions",
] as const

/** `delivery_config` for the saved fields (the database checks `type` matches the column). */
export function deliveryConfigFor(fields: LaunchFields): DeliveryConfig | null {
  switch (fields.deliveryType) {
    case null:
      return null
    case "file":
      return { type: "file" }
    case "license_key":
      return fields.instructions
        ? { type: "license_key", instructions: fields.instructions }
        : { type: "license_key" }
    case "url":
      // A URL launch without a URL yet is a draft; the approval checks for it.
      return fields.deliveryUrl ? { type: "url", url: fields.deliveryUrl } : null
  }
}

const deliveryConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file") }),
  z.object({ type: z.literal("license_key"), instructions: z.string().optional() }),
  z.object({ type: z.literal("url"), url: z.string() }),
])

/** A stored `delivery_config`, read tolerantly (null when malformed). */
export function parseDeliveryConfig(value: unknown): DeliveryConfig | null {
  const parsed = deliveryConfigSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

// --- Completeness (what an approval needs) --------------------------------------------------

export type LaunchContent = {
  title: string
  priceCents: number | null
  deliveryType: DeliveryType | null
  deliveryConfig: DeliveryConfig | null
  fileCount: number
  unassignedKeyCount: number
}

/**
 * What is still missing before a member can approve (§19.31: title, price, delivery type and its
 * content: ≥ 1 file, ≥ 1 unassigned key, or an https URL). Empty when complete.
 */
export function missingForApproval(launch: LaunchContent): string[] {
  const missing: string[] = []
  if (!launch.title.trim()) missing.push("a title")
  if (launch.priceCents === null) missing.push("a price")
  switch (launch.deliveryType) {
    case null:
      missing.push("how buyers get the product")
      break
    case "file":
      if (launch.fileCount === 0) missing.push("at least one file for buyers")
      break
    case "license_key":
      if (launch.unassignedKeyCount === 0) missing.push("at least one license key")
      break
    case "url": {
      const config = launch.deliveryConfig
      if (!config || config.type !== "url" || !config.url.startsWith("https://")) {
        missing.push("the link buyers are sent to")
      }
      break
    }
  }
  return missing
}

export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

// --- License keys ---------------------------------------------------------------------------

export type ParsedKeys = { keys: string[]; duplicates: number; tooLong: number }

/** Pasted keys, one per line (commas or semicolons also separate); trimmed, deduplicated. */
export function parseLicenseKeys(text: string): ParsedKeys {
  const seen = new Set<string>()
  let duplicates = 0
  let tooLong = 0
  for (const part of text.split(/[\r\n,;]+/)) {
    const key = part.trim()
    if (!key) continue
    if (key.length > LICENSE_KEY_MAX) {
      tooLong += 1
      continue
    }
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)
  }
  return { keys: [...seen], duplicates, tooLong }
}

// --- Uploads --------------------------------------------------------------------------------

export const DELIVERABLE_POLICY = UPLOAD_LIMITS.deliverable
export const MEDIA_POLICY = UPLOAD_LIMITS.image
type DeliverableType = (typeof DELIVERABLE_POLICY.mimeTypes)[number]
type MediaType = (typeof MEDIA_POLICY.mimeTypes)[number]

/** One extension per allowed type: a stored key's extension names the type it was checked as. */
export const DELIVERABLE_EXTENSIONS: Record<DeliverableType, string> = {
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/epub+zip": "epub",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "font/woff2": "woff2",
}

export const MEDIA_EXTENSIONS: Record<MediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

export const DELIVERABLE_ACCEPT = [
  ...DELIVERABLE_POLICY.mimeTypes,
  ...new Set(Object.values(DELIVERABLE_EXTENSIONS).map((extension) => `.${extension}`)),
].join(",")
export const MEDIA_ACCEPT = MEDIA_POLICY.mimeTypes.join(",")

export const LAUNCH_UPLOAD_PREFIX = "launch-uploads"
export const LAUNCH_FILE_PREFIX = "launch-files"
export const LAUNCH_MEDIA_PREFIX = "launch-media"

export type UploadKind = "deliverable" | "media"

export type FileCheck = { ok: true; contentType: string } | { ok: false; message: string }

/** Browsers leave `File.type` empty for some files; fall back to the extension. */
export function fileTypeOf(file: { name: string; type: string }, kind: UploadKind): string {
  const type = normalizeMimeType(file.type)
  if (type) return type
  const extension = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase()
  const table: Record<string, string> =
    kind === "deliverable" ? DELIVERABLE_EXTENSIONS : MEDIA_EXTENSIONS
  return Object.entries(table).find(([, ext]) => ext === extension)?.[0] ?? ""
}

/** Check a file against the deliverable (200 MB) or media (10 MB image) policy, in plain words. */
export function checkLaunchUpload(
  kind: UploadKind,
  file: { contentType: string; sizeBytes: number },
): FileCheck {
  const check = validateUpload(kind === "deliverable" ? "deliverable" : "image", file)
  if (check.ok) return check
  if (check.reason !== "type") return { ok: false, message: check.message }
  return {
    ok: false,
    message:
      kind === "media"
        ? "Add PNG, JPEG, WebP or GIF images."
        : "You can upload archives (ZIP), PDFs, documents, images, audio, video, e-books and fonts.",
  }
}

export function extensionFor(kind: UploadKind, contentType: string): string | null {
  const table: Record<string, string> =
    kind === "deliverable" ? DELIVERABLE_EXTENSIONS : MEDIA_EXTENSIONS
  return table[normalizeMimeType(contentType)] ?? null
}

/** The prefix a user's pending launch uploads live under (signed PUT URLs point here only). */
export function launchUploadPrefix(userId: string): string {
  return `${LAUNCH_UPLOAD_PREFIX}/${userId}/`
}

const UPLOAD_NAME = /^[0-9a-f-]{36}\.([a-z0-9]+)$/

/** An upload key of this user, shaped as we issue them (`launch-uploads/<user>/<uuid>.<ext>`). */
export function isOwnLaunchUploadKey(userId: string, key: string, kind: UploadKind): boolean {
  const prefix = launchUploadPrefix(userId)
  if (!key.startsWith(prefix)) return false
  const extension = UPLOAD_NAME.exec(key.slice(prefix.length))?.[1]
  if (!extension) return false
  const table: Record<string, string> =
    kind === "deliverable" ? DELIVERABLE_EXTENSIONS : MEDIA_EXTENSIONS
  return Object.values(table).includes(extension)
}

/** The name buyers see for a file: no path, no control characters, at most 120 characters. */
export function cleanFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]+/g, "").trim()
  if (!base) return "file"
  if (base.length <= 120) return base
  const dot = base.lastIndexOf(".")
  const extension = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : ""
  return `${base.slice(0, 119 - extension.length)}…${extension}`
}

/** Media alt text: one line, ≤ 200 characters; empty → the fallback. */
export function cleanAlt(alt: string | null | undefined, fallback: string): string {
  const text = collapseLine(alt ?? "")
  return (text || fallback).slice(0, MEDIA_ALT_MAX)
}

const mediaSchema = z.object({
  kind: z.enum(["image", "video"]),
  url: z.string().min(1),
  alt: z.string(),
})

/** Stored `launches.media`, read tolerantly (malformed entries dropped). */
export function parseMedia(value: unknown): LaunchMedia[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const parsed = mediaSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

/** The file name part of a media storage key (`<uuid>.<ext>`), used in its public URL. */
export function mediaName(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1)
}

/** The app route that serves a launch image (a redirect to a short-lived signed URL). */
export function launchMediaPath(launchId: string, key: string): string {
  return `/api/launches/${launchId}/media/${mediaName(key)}`
}

// --- Review note ----------------------------------------------------------------------------

export const reviewNoteSchema = z
  .string({ error: "Tell the members what to change." })
  .transform(normalizeMultiline)
  .pipe(
    z
      .string()
      .min(1, "Tell the members what to change.")
      .max(
        REVIEW_NOTE_MAX,
        `Keep the note under ${REVIEW_NOTE_MAX.toLocaleString("en-US")} characters.`,
      ),
  )

// --- Statuses for people --------------------------------------------------------------------

/** One line per status for the members' status panel. */
export const LAUNCH_STATUS_DESCRIPTIONS: Record<LaunchStatus, string> = {
  draft: "Set it up together. When it's ready, each of you approves it.",
  pending_approval: "One of you approved this version. It goes to review once both approve.",
  admin_review: "Both of you approved it. Our team checks it before it goes live.",
  live: "It's on sale. Share your tracked link to send buyers its way.",
  paused: "Sales are paused. The product page says it's unavailable.",
  ended: "Sales have ended. Buyers keep their access.",
}
