import { z } from "zod"

import type { Availability, DealPreference, ProductFormat } from "@/lib/db/schema/enums"

import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH, HANDLE_REGEX } from "./handle-format"
import { isCountryCode, isLanguageCode, type CountryCode, type LanguageCode } from "./locale"

/**
 * Profile forms (§5 creator_profiles / builder_profiles / portfolio_items, §12 onboarding and
 * settings pages): limits, labels and the Zod schemas shared by the forms and the server actions.
 * Client-safe (type-only schema import).
 *
 * Topics are not on the creator form: the audience summary writes them and the creator edits them
 * next to it (review step, /app/audience), see CLAUDE.md §19.15.
 */

export const DISPLAY_NAME_MAX = 60
export const BIO_MAX = 500
export const NICHE_MAX = 80
export const LANGUAGES_MAX = 6
export const TAGS_MAX = 12
export const TAG_MAX_LENGTH = 40
export const PORTFOLIO_TITLE_MAX = 80
export const PORTFOLIO_DESCRIPTION_MAX = 300
export const PORTFOLIO_URL_MAX = 500
/** Portfolio items per builder profile. */
export const PORTFOLIO_MAX_ITEMS = 12

// --- Labels ------------------------------------------------------------------------------------

export const AVAILABILITY_VALUES = ["open", "limited", "closed"] as const satisfies Availability[]

export const AVAILABILITY_LABELS: Record<Availability, { title: string; description: string }> = {
  open: { title: "Open to new collabs", description: "You're looking for creators to work with." },
  limited: {
    title: "Limited availability",
    description: "You'll take on the right project, but not many.",
  },
  closed: {
    title: "Not taking new collabs",
    description: "Creators won't see you in their matches for now.",
  },
}

export const DEAL_PREFERENCE_VALUES = [
  "split",
  "either",
  "fixed",
] as const satisfies DealPreference[]

export const DEAL_PREFERENCE_LABELS: Record<
  DealPreference,
  { title: string; description: string }
> = {
  split: { title: "Revenue split", description: "You share the sales with the creator." },
  fixed: { title: "Fixed fee", description: "You prefer to be paid for the build." },
  either: { title: "Either works", description: "You'll decide per collab." },
}

export const PRODUCT_FORMAT_VALUES = [
  "app",
  "tool",
  "template",
  "ai_utility",
  "course_tool",
  "other",
] as const satisfies ProductFormat[]

export const PRODUCT_FORMAT_LABELS: Record<ProductFormat, string> = {
  app: "App",
  tool: "Tool",
  template: "Template",
  ai_utility: "AI utility",
  course_tool: "Course tool",
  other: "Other",
}

// --- Handles -----------------------------------------------------------------------------------

/**
 * Handles nobody may take: words that would read as the platform speaking, plus route-like words.
 * Public URLs are /c/<handle> and /b/<handle>, so none of these collide with routes; they are
 * reserved so a profile cannot pose as staff.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "api",
  "app",
  "billing",
  "help",
  "mod",
  "moderator",
  "null",
  "official",
  "payouts",
  "platform",
  "root",
  "security",
  "settings",
  "staff",
  "stripe",
  "support",
  "system",
  "team",
  "undefined",
  "vincera",
])

/** " @Ada.Codes " → "ada.codes" (still invalid: dots are not allowed; the schema says so). */
export function normalizeHandle(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase()
}

export const HANDLE_FORMAT_MESSAGE = `Use ${HANDLE_MIN_LENGTH}–${HANDLE_MAX_LENGTH} lowercase letters, numbers or underscores.`

export const handleSchema = z
  .string({ error: "Choose a handle." })
  .transform(normalizeHandle)
  .pipe(
    z
      .string()
      .min(1, "Choose a handle.")
      .regex(HANDLE_REGEX, HANDLE_FORMAT_MESSAGE)
      .refine((handle) => !RESERVED_HANDLES.has(handle), "That handle is reserved. Try another."),
  )

// --- Field helpers -----------------------------------------------------------------------------

/** Trim and collapse whitespace runs (names, niches, tags). */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** Optional free text: trimmed; empty → null. Line breaks are kept (bios). */
function optionalText(max: number, tooLong: string) {
  return z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = (value ?? "").replace(/\r\n?/g, "\n").trim()
      return trimmed === "" ? null : trimmed
    })
    .pipe(z.string().max(max, tooLong).nullable())
}

function optionalLine(max: number, tooLong: string) {
  return z
    .string()
    .optional()
    .transform((value) => {
      const collapsed = collapseWhitespace(value ?? "")
      return collapsed === "" ? null : collapsed
    })
    .pipe(z.string().max(max, tooLong).nullable())
}

const displayNameSchema = z
  .string({ error: "Enter the name people know you by." })
  .transform(collapseWhitespace)
  .pipe(
    z
      .string()
      .min(1, "Enter the name people know you by.")
      .max(DISPLAY_NAME_MAX, `Keep your name under ${DISPLAY_NAME_MAX} characters.`),
  )

/**
 * "TypeScript, next.js ,Next.js" → ["TypeScript", "next.js"]: comma or line separated, whitespace
 * collapsed, duplicates dropped ignoring case (the first spelling wins).
 */
export function parseTagList(value: string): string[] {
  const tags: string[] = []
  const seen = new Set<string>()
  for (const part of value.split(/[,\n]/)) {
    const tag = collapseWhitespace(part)
    const key = tag.toLowerCase()
    if (tag && !seen.has(key)) {
      seen.add(key)
      tags.push(tag)
    }
  }
  return tags
}

function tagListSchema(noun: string) {
  return z
    .string()
    .optional()
    .transform((value) => parseTagList(value ?? ""))
    .pipe(
      z
        .array(
          z.string().max(TAG_MAX_LENGTH, `Keep each ${noun} under ${TAG_MAX_LENGTH} characters.`),
        )
        .max(TAGS_MAX, `List at most ${TAGS_MAX} ${noun}s.`),
    )
}

/** A form value that may be one string, several (repeated checkboxes) or missing. */
const stringList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]))

const languagesSchema = stringList.pipe(
  z
    .array(z.string().refine(isLanguageCode, "Pick languages from the list."))
    .max(LANGUAGES_MAX, `Pick at most ${LANGUAGES_MAX} languages.`)
    .transform((codes) => [...new Set(codes)] as LanguageCode[]),
)

const countrySchema = z
  .string()
  .optional()
  .transform((value) => (value ?? "").trim().toUpperCase())
  .pipe(
    z
      .string()
      .refine((code) => code === "" || isCountryCode(code), "Pick a country from the list.")
      .transform((code) => (code === "" ? null : (code as CountryCode))),
  )

/**
 * A link a person typed: `https://` is added when the scheme is missing; only http(s) is accepted
 * (anything else could run script from an href).
 */
export function normalizeWebUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === "") return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null
    return url.toString()
  } catch {
    return null
  }
}

const optionalWebUrl = z
  .string()
  .optional()
  .transform((value, context) => {
    const raw = (value ?? "").trim()
    if (raw === "") return null
    const url = normalizeWebUrl(raw)
    if (url === null) {
      context.addIssue({
        code: "custom",
        message: "Enter a web address, like https://example.com.",
      })
      return z.NEVER
    }
    return url
  })
  .pipe(z.string().max(PORTFOLIO_URL_MAX, "That link is too long.").nullable())

/** A checkbox: present ("on") when ticked, missing otherwise. Booleans pass through (tests). */
const checkbox = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((value) => value === true || value === "on" || value === "true")

// --- Forms -------------------------------------------------------------------------------------

/** Where a profile form was submitted from: the onboarding step continues to the next step. */
export const PROFILE_FORM_SOURCES = ["onboarding", "settings"] as const
export type ProfileFormSource = (typeof PROFILE_FORM_SOURCES)[number]

export const creatorProfileFormSchema = z.object({
  displayName: displayNameSchema,
  handle: handleSchema,
  niche: optionalLine(NICHE_MAX, `Keep your niche under ${NICHE_MAX} characters.`),
  bio: optionalText(BIO_MAX, `Keep your bio under ${BIO_MAX} characters.`),
  country: countrySchema,
  languages: languagesSchema,
})
export type CreatorProfileForm = z.output<typeof creatorProfileFormSchema>

export const builderProfileFormSchema = z.object({
  displayName: displayNameSchema,
  handle: handleSchema,
  bio: optionalText(BIO_MAX, `Keep your bio under ${BIO_MAX} characters.`),
  skills: tagListSchema("skill"),
  stack: tagListSchema("tool"),
  availability: z.enum(AVAILABILITY_VALUES, { error: "Choose your availability." }),
  dealPreference: z.enum(DEAL_PREFERENCE_VALUES, { error: "Choose how you like to be paid." }),
})
export type BuilderProfileForm = z.output<typeof builderProfileFormSchema>

export const portfolioItemFormSchema = z.object({
  title: z
    .string({ error: "Give it a title." })
    .transform(collapseWhitespace)
    .pipe(
      z
        .string()
        .min(1, "Give it a title.")
        .max(PORTFOLIO_TITLE_MAX, `Keep the title under ${PORTFOLIO_TITLE_MAX} characters.`),
    ),
  url: optionalWebUrl,
  description: optionalText(
    PORTFOLIO_DESCRIPTION_MAX,
    `Keep the description under ${PORTFOLIO_DESCRIPTION_MAX} characters.`,
  ),
  format: z
    .union([z.literal(""), z.enum(PRODUCT_FORMAT_VALUES)], {
      error: "Pick a format from the list.",
    })
    .optional()
    .transform((value) => (value === "" || value === undefined ? null : value)),
  isShipped: checkbox,
})
export type PortfolioItemForm = z.output<typeof portfolioItemFormSchema>

export const accountNameFormSchema = z.object({
  name: z
    .string({ error: "Enter your name." })
    .transform(collapseWhitespace)
    .pipe(
      z
        .string()
        .min(1, "Enter your name.")
        .max(DISPLAY_NAME_MAX, `Keep your name under ${DISPLAY_NAME_MAX} characters.`),
    ),
})
