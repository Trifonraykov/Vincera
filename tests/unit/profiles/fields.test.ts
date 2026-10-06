import { describe, expect, it } from "vitest"

import { HANDLE_PATTERN as SCHEMA_HANDLE_PATTERN } from "@/lib/db/schema"
import {
  accountNameFormSchema,
  builderProfileFormSchema,
  creatorProfileFormSchema,
  handleSchema,
  normalizeHandle,
  normalizeWebUrl,
  parseTagList,
  portfolioItemFormSchema,
  RESERVED_HANDLES,
} from "@/lib/profiles/fields"
import { HANDLE_PATTERN } from "@/lib/profiles/handle-format"
import { handleBase } from "@/lib/profiles/handles"
import {
  checkPortfolioImage,
  isOwnPortfolioImageKey,
  isOwnPortfolioUploadKey,
  portfolioImagePath,
  portfolioImagePrefix,
  portfolioUploadPrefix,
} from "@/lib/profiles/image-policy"
import {
  COUNTRY_CODES,
  countryName,
  countryOptions,
  isCountryCode,
  isLanguageCode,
  LANGUAGE_CODES,
  languageName,
} from "@/lib/profiles/locale"
import { audienceSummaryFormSchema } from "@/lib/social/summary-form"

function firstIssue(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? null : (result.error?.issues[0]?.message ?? null)
}

describe("handles", () => {
  it("shares one pattern with the database CHECK", () => {
    expect(SCHEMA_HANDLE_PATTERN).toBe(HANDLE_PATTERN)
  })

  it("normalizes what people type", () => {
    expect(normalizeHandle("  @Ada_Codes ")).toBe("ada_codes")
    expect(handleSchema.parse("@@ADA_99")).toBe("ada_99")
  })

  it("refuses bad formats and reserved words with plain messages", () => {
    expect(firstIssue(handleSchema.safeParse(""))).toBe("Choose a handle.")
    expect(firstIssue(handleSchema.safeParse("ab"))).toMatch(/3–30 lowercase letters/)
    expect(firstIssue(handleSchema.safeParse("ada.codes"))).toMatch(/lowercase letters/)
    expect(firstIssue(handleSchema.safeParse("a".repeat(31)))).toMatch(/3–30/)
    expect(firstIssue(handleSchema.safeParse("Admin"))).toBe(
      "That handle is reserved. Try another.",
    )
    for (const handle of RESERVED_HANDLES)
      expect(handleSchema.safeParse(handle).success).toBe(false)
  })

  it("reserves the app's route words and the one-letter public prefixes", () => {
    for (const word of ["admin", "app", "api", "settings", "onboarding", "c", "b", "p", "r"]) {
      expect(RESERVED_HANDLES.has(word)).toBe(true)
    }
    expect(firstIssue(handleSchema.safeParse("@Settings"))).toBe(
      "That handle is reserved. Try another.",
    )
    // Too short anyway: the format message comes first.
    expect(firstIssue(handleSchema.safeParse("c"))).toMatch(/3–30 lowercase letters/)
    expect(handleSchema.safeParse("settings_fan").success).toBe(true)
  })

  it("derives a handle base from names and emails", () => {
    expect(handleBase("Ada Lovelace")).toBe("ada_lovelace")
    expect(handleBase("José Müller-Ñúñez")).toBe("jose_muller_nunez")
    expect(handleBase("ada.codes+news")).toBe("ada_codes_news")
    expect(handleBase("!!!")).toBe("")
    expect(handleBase("x".repeat(60))).toHaveLength(25)
  })
})

describe("lists and links", () => {
  it("parses comma or line separated tags, dropping duplicates ignoring case", () => {
    expect(parseTagList("TypeScript, next.js ,Next.js\n  Postgres  ,,")).toEqual([
      "TypeScript",
      "next.js",
      "Postgres",
    ])
    expect(parseTagList("")).toEqual([])
  })

  it("accepts only http(s) web addresses and adds https:// when missing", () => {
    expect(normalizeWebUrl("example.com/app")).toBe("https://example.com/app")
    expect(normalizeWebUrl(" http://example.com ")).toBe("http://example.com/")
    expect(normalizeWebUrl("javascript:alert(1)")).toBeNull()
    expect(normalizeWebUrl("data:text/html,x")).toBeNull()
    expect(normalizeWebUrl("ftp://example.com")).toBeNull()
    expect(normalizeWebUrl("not a url")).toBeNull()
    expect(normalizeWebUrl("")).toBeNull()
  })
})

describe("creatorProfileFormSchema", () => {
  const valid = {
    displayName: "  Ada   Codes ",
    handle: "@Ada_Codes",
    niche: "  Notion  tutorials ",
    bio: "  Line one\r\nLine two  ",
    country: "de",
    languages: ["en", "es", "en"],
  }

  it("normalizes a valid form", () => {
    expect(creatorProfileFormSchema.parse(valid)).toEqual({
      displayName: "Ada Codes",
      handle: "ada_codes",
      niche: "Notion tutorials",
      bio: "Line one\nLine two",
      topics: [],
      country: "DE",
      languages: ["en", "es"],
    })
  })

  it("gives the same topics as the audience summary form for the same text", () => {
    for (const topics of ["fitness, #budget, #Meal Prep", " #a,#b ,  ##c\nd_e", "x, X, #x"]) {
      expect(creatorProfileFormSchema.parse({ ...valid, topics }).topics).toEqual(
        audienceSummaryFormSchema.parse({ summary: "s", topics }).topics,
      )
    }
    expect(
      creatorProfileFormSchema.parse({ ...valid, topics: "fitness, #budget, #Meal Prep" }).topics,
    ).toEqual(["fitness", "budget", "meal prep"])
  })

  it("normalizes topics like the audience summary (lowercase, no #, deduplicated)", () => {
    expect(
      creatorProfileFormSchema.parse({ ...valid, topics: "Meal Prep, #budget, meal prep,  " })
        .topics,
    ).toEqual(["meal prep", "budget"])
    // Repeated fields (a tag input posting one value per tag) work too.
    expect(
      creatorProfileFormSchema.parse({ ...valid, topics: ["Fitness", "yoga"] }).topics,
    ).toEqual(["fitness", "yoga"])
    expect(
      firstIssue(
        creatorProfileFormSchema.safeParse({
          ...valid,
          topics: Array.from({ length: 9 }, (_, index) => `topic ${index}`).join(","),
        }),
      ),
    ).toBe("Pick at most 8 topics.")
    expect(
      firstIssue(creatorProfileFormSchema.safeParse({ ...valid, topics: "x".repeat(41) })),
    ).toBe("Keep each topic under 40 characters.")
  })

  it("treats blank optional fields as empty and a single language as a list", () => {
    expect(
      creatorProfileFormSchema.parse({
        displayName: "Ada",
        handle: "ada",
        niche: "  ",
        bio: "",
        country: "",
        languages: "pt",
      }),
    ).toMatchObject({ niche: null, bio: null, country: null, languages: ["pt"] })
    expect(creatorProfileFormSchema.parse({ displayName: "Ada", handle: "ada" })).toMatchObject({
      niche: null,
      bio: null,
      country: null,
      languages: [],
    })
  })

  it("refuses unknown countries and languages, too many languages and long text", () => {
    expect(firstIssue(creatorProfileFormSchema.safeParse({ ...valid, country: "XX" }))).toBe(
      "Pick a country from the list.",
    )
    expect(
      firstIssue(creatorProfileFormSchema.safeParse({ ...valid, languages: ["klingon"] })),
    ).toBe("Pick languages from the list.")
    expect(
      firstIssue(
        creatorProfileFormSchema.safeParse({
          ...valid,
          languages: ["en", "es", "pt", "fr", "de", "it", "nl"],
        }),
      ),
    ).toBe("Pick at most 6 languages.")
    expect(
      firstIssue(creatorProfileFormSchema.safeParse({ ...valid, bio: "x".repeat(501) })),
    ).toMatch(/under 500/)
    expect(firstIssue(creatorProfileFormSchema.safeParse({ ...valid, displayName: "  " }))).toBe(
      "Enter the name people know you by.",
    )
  })
})

describe("builderProfileFormSchema", () => {
  it("parses tags, availability and deal preference", () => {
    expect(
      builderProfileFormSchema.parse({
        displayName: "Octo",
        handle: "octo_builder",
        bio: "",
        skills: "Web apps, AI tools",
        stack: "TypeScript, Postgres, typescript",
        availability: "limited",
        dealPreference: "split",
      }),
    ).toEqual({
      displayName: "Octo",
      handle: "octo_builder",
      bio: null,
      skills: ["Web apps", "AI tools"],
      stack: ["TypeScript", "Postgres"],
      availability: "limited",
      dealPreference: "split",
    })
  })

  it("refuses too many or too long tags and unknown choices", () => {
    const base = {
      displayName: "Octo",
      handle: "octo",
      availability: "open",
      dealPreference: "either",
    }
    const many = Array.from({ length: 13 }, (_, index) => `skill ${index}`).join(",")
    expect(firstIssue(builderProfileFormSchema.safeParse({ ...base, skills: many }))).toBe(
      "List at most 12 skills.",
    )
    expect(firstIssue(builderProfileFormSchema.safeParse({ ...base, stack: "x".repeat(41) }))).toBe(
      "Keep each tool under 40 characters.",
    )
    expect(
      firstIssue(builderProfileFormSchema.safeParse({ ...base, availability: "always" })),
    ).toBe("Choose your availability.")
    expect(
      firstIssue(builderProfileFormSchema.safeParse({ ...base, dealPreference: undefined })),
    ).toBe("Choose how you like to be paid.")
  })
})

describe("portfolioItemFormSchema", () => {
  it("normalizes the link, format and shipped checkbox", () => {
    expect(
      portfolioItemFormSchema.parse({
        title: "  Invoice   generator ",
        url: "invoices.example.com",
        description: "",
        format: "tool",
        isShipped: "on",
      }),
    ).toEqual({
      title: "Invoice generator",
      url: "https://invoices.example.com/",
      description: null,
      format: "tool",
      isShipped: true,
      imageKey: null,
      removeImage: false,
    })
    expect(portfolioItemFormSchema.parse({ title: "Draft", format: "" })).toEqual({
      title: "Draft",
      url: null,
      description: null,
      format: null,
      isShipped: false,
      imageKey: null,
      removeImage: false,
    })
    expect(
      portfolioItemFormSchema.parse({
        title: "X",
        imageKey: " portfolio-images/u/i.png ",
        removeImage: "on",
      }),
    ).toMatchObject({ imageKey: "portfolio-images/u/i.png", removeImage: true })
  })

  it("refuses script links and unknown formats", () => {
    expect(
      firstIssue(portfolioItemFormSchema.safeParse({ title: "X", url: "javascript:alert(1)" })),
    ).toBe("Enter a web address, like https://example.com.")
    expect(firstIssue(portfolioItemFormSchema.safeParse({ title: "X", format: "nft" }))).toBe(
      "Pick a format from the list.",
    )
    expect(firstIssue(portfolioItemFormSchema.safeParse({ title: " " }))).toBe("Give it a title.")
  })
})

describe("portfolio image policy", () => {
  const userId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"

  it("allows PNG, JPEG, WebP and GIF up to 10 MB, never SVG", () => {
    expect(checkPortfolioImage({ contentType: "image/PNG", sizeBytes: 1000 })).toEqual({
      ok: true,
      contentType: "image/png",
    })
    expect(checkPortfolioImage({ contentType: "image/svg+xml", sizeBytes: 1000 })).toEqual({
      ok: false,
      message: "Upload a PNG, JPEG, WebP or GIF image.",
    })
    expect(checkPortfolioImage({ contentType: "image/gif", sizeBytes: 0 })).toEqual({
      ok: false,
      message: "This image is empty.",
    })
    expect(
      checkPortfolioImage({ contentType: "image/jpeg", sizeBytes: 10 * 1024 * 1024 + 1 }),
    ).toEqual({ ok: false, message: "This image is too large. The limit is 10 MB." })
  })

  it("accepts only the user's own generated keys", () => {
    const prefix = portfolioImagePrefix(userId)
    expect(isOwnPortfolioImageKey(userId, `${prefix}0199a1b2-aaaa.png`)).toBe(true)
    expect(isOwnPortfolioImageKey(userId, `${prefix}../other/x.png`)).toBe(false)
    expect(isOwnPortfolioImageKey(userId, `${prefix}nested/x.png`)).toBe(false)
    expect(isOwnPortfolioImageKey(userId, `${prefix}x.svg`)).toBe(false)
    expect(isOwnPortfolioImageKey(userId, `portfolio-images/someone-else/x.png`)).toBe(false)
    expect(isOwnPortfolioImageKey(userId, `social-evidence/${userId}/x.png`)).toBe(false)
  })

  it("keeps uploads and saved images apart: a save accepts upload keys only", () => {
    const upload = `${portfolioUploadPrefix(userId)}0199a1b2-aaaa.png`
    const saved = `${portfolioImagePrefix(userId)}0199a1b2-aaaa.png`
    expect(isOwnPortfolioUploadKey(userId, upload)).toBe(true)
    expect(isOwnPortfolioUploadKey(userId, saved)).toBe(false)
    expect(isOwnPortfolioImageKey(userId, upload)).toBe(false)
    expect(isOwnPortfolioUploadKey(userId, `portfolio-uploads/someone-else/x.png`)).toBe(false)
  })

  it("points pages at the image route, versioned by the upload", () => {
    expect(portfolioImagePath("item-1", null)).toBeNull()
    expect(portfolioImagePath("item-1", "portfolio-images/u/0199-abc.webp")).toBe(
      "/api/portfolio/item-1/image?v=0199-abc",
    )
  })
})

describe("accountNameFormSchema", () => {
  it("collapses whitespace and requires a name", () => {
    expect(accountNameFormSchema.parse({ name: "  Ada   Lovelace " })).toEqual({
      name: "Ada Lovelace",
    })
    expect(firstIssue(accountNameFormSchema.safeParse({ name: "" }))).toBe("Enter your name.")
  })
})

describe("locale lists", () => {
  it("has unique, well-formed codes with English names", () => {
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length)
    expect(COUNTRY_CODES.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true)
    expect(new Set(LANGUAGE_CODES).size).toBe(LANGUAGE_CODES.length)
    expect(LANGUAGE_CODES.every((code) => /^[a-z]{2,3}$/.test(code))).toBe(true)
    expect(countryName("DE")).toBe("Germany")
    expect(languageName("es")).toBe("Spanish")
    expect(isCountryCode("ES")).toBe(true)
    expect(isCountryCode("es")).toBe(false)
    expect(isLanguageCode("fil")).toBe(true)
    const options = countryOptions()
    expect(options).toHaveLength(COUNTRY_CODES.length)
    expect(options[0]?.name.localeCompare(options[1]?.name ?? "", "en")).toBeLessThan(0)
  })
})
