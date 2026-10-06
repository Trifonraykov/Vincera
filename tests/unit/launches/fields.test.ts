import { describe, expect, it } from "vitest"

import {
  baseSlug,
  checkLaunchUpload,
  cleanFilename,
  deliveryConfigFor,
  isOwnLaunchUploadKey,
  isValidSlug,
  joinList,
  launchFormSchema,
  launchMediaPath,
  mediaName,
  missingForApproval,
  parseLicenseKeys,
  parseMedia,
  slugCandidates,
  slugify,
} from "@/lib/launches/fields"
import { collabStageForLaunch, launchStatusAfter } from "@/lib/launches/status"

/** Launch setup rules (CLAUDE.md §19.32): slugs, the form, completeness, keys and uploads. */

const USER = "0190a0a0-0000-7000-8000-000000000001"
const LAUNCH = "0190a0a0-0000-7000-8000-000000000002"

describe("slugs", () => {
  it("turns titles into slugs: lowercase, accents and symbols dropped, dashes", () => {
    expect(slugify("Budget Tracker für Studenten!")).toBe("budget-tracker-fur-studenten")
    expect(slugify("  --Hello__World--  ")).toBe("hello-world")
    expect(slugify("🚀")).toBe("")
    const long = slugify("word ".repeat(40))
    expect(long.length).toBeLessThanOrEqual(80)
    expect(isValidSlug(long)).toBe(true)
  })

  it("pads short titles and offers numbered alternatives within 80 characters", () => {
    expect(baseSlug("AI")).toBe("ai-launch")
    expect(baseSlug("!!")).toBe("launch")
    expect(slugCandidates("planner", 3)).toEqual(["planner", "planner-2", "planner-3"])
    const base = "a".repeat(80)
    for (const candidate of slugCandidates(base)) expect(isValidSlug(candidate)).toBe(true)
  })

  it("validates the stored format", () => {
    expect(isValidSlug("meal-planner")).toBe(true)
    for (const bad of ["ab", "Meal", "meal--planner", "-meal", "meal_planner", "a".repeat(81)]) {
      expect(isValidSlug(bad), bad).toBe(false)
    }
  })
})

describe("the setup form", () => {
  it("parses a complete form into cents, a slug and an https delivery URL", () => {
    const fields = launchFormSchema.parse({
      title: "  Meal   planner ",
      tagline: "",
      descriptionMd: "Line one\r\nLine two",
      price: "19,99",
      slug: "Meal Planner",
      deliveryType: "url",
      deliveryUrl: "app.example.com/welcome",
      instructions: "",
    })
    expect(fields).toEqual({
      title: "Meal planner",
      tagline: null,
      descriptionMd: "Line one\nLine two",
      price: 1999,
      slug: "meal-planner",
      deliveryType: "url",
      deliveryUrl: "https://app.example.com/welcome",
      instructions: null,
    })
    expect(deliveryConfigFor(fields)).toEqual({
      type: "url",
      url: "https://app.example.com/welcome",
    })
  })

  it("refuses prices outside €0.50–€10,000 and non-https links", () => {
    const parse = (values: Record<string, string>) =>
      launchFormSchema.safeParse({ title: "x", slug: "abc", ...values })
    expect(parse({ price: "0.49" }).success).toBe(false)
    expect(parse({ price: "10000.01" }).success).toBe(false)
    expect(parse({ price: "0.50" }).success).toBe(true)
    expect(parse({ deliveryUrl: "http://example.com" }).success).toBe(false)
    expect(parse({ deliveryUrl: "javascript:alert(1)" }).success).toBe(false)
    expect(parse({ price: "" }).data?.price).toBeNull()
  })

  it("builds the delivery config per type (a URL launch without a URL has none yet)", () => {
    const base = launchFormSchema.parse({ title: "x", slug: "abc" })
    expect(deliveryConfigFor(base)).toBeNull()
    expect(deliveryConfigFor({ ...base, deliveryType: "file" })).toEqual({ type: "file" })
    expect(deliveryConfigFor({ ...base, deliveryType: "url" })).toBeNull()
    expect(
      deliveryConfigFor({
        ...base,
        deliveryType: "license_key",
        instructions: "Use it in Settings",
      }),
    ).toEqual({ type: "license_key", instructions: "Use it in Settings" })
  })
})

describe("completeness", () => {
  const complete = {
    title: "Planner",
    priceCents: 1900,
    deliveryType: "url" as const,
    deliveryConfig: { type: "url" as const, url: "https://x.example.com" },
    fileCount: 0,
    unassignedKeyCount: 0,
  }
  it("lists what is missing before approval", () => {
    expect(missingForApproval(complete)).toEqual([])
    expect(
      missingForApproval({
        ...complete,
        priceCents: null,
        deliveryType: null,
        deliveryConfig: null,
      }),
    ).toEqual(["a price", "how buyers get the product"])
    expect(missingForApproval({ ...complete, deliveryType: "file" })).toEqual([
      "at least one file for buyers",
    ])
    expect(missingForApproval({ ...complete, deliveryType: "license_key" })).toEqual([
      "at least one license key",
    ])
    expect(missingForApproval({ ...complete, deliveryConfig: null })).toEqual([
      "the link buyers are sent to",
    ])
    expect(joinList(["a", "b", "c"])).toBe("a, b and c")
  })
})

describe("license keys and uploads", () => {
  it("splits pasted keys, trims, deduplicates and skips long ones", () => {
    expect(parseLicenseKeys(" A-1 \r\nA-2,A-1;\n\n" + "x".repeat(201))).toEqual({
      keys: ["A-1", "A-2"],
      duplicates: 1,
      tooLong: 1,
    })
  })

  it("checks types and sizes per purpose; SVG and HTML are never allowed", () => {
    expect(
      checkLaunchUpload("deliverable", { contentType: "application/zip", sizeBytes: 10 }),
    ).toEqual({
      ok: true,
      contentType: "application/zip",
    })
    expect(
      checkLaunchUpload("deliverable", {
        contentType: "application/zip",
        sizeBytes: 201 * 1024 * 1024,
      }).ok,
    ).toBe(false)
    expect(checkLaunchUpload("media", { contentType: "image/svg+xml", sizeBytes: 10 }).ok).toBe(
      false,
    )
    expect(checkLaunchUpload("deliverable", { contentType: "text/html", sizeBytes: 10 }).ok).toBe(
      false,
    )
    expect(checkLaunchUpload("media", { contentType: "application/pdf", sizeBytes: 10 }).ok).toBe(
      false,
    )
  })

  it("accepts only the user's own upload keys of the right kind", () => {
    const key = `launch-uploads/${USER}/0190a0a0-0000-7000-8000-00000000000a.pdf`
    expect(isOwnLaunchUploadKey(USER, key, "deliverable")).toBe(true)
    expect(isOwnLaunchUploadKey(USER, key, "media")).toBe(false)
    expect(isOwnLaunchUploadKey(LAUNCH, key, "deliverable")).toBe(false)
    expect(isOwnLaunchUploadKey(USER, `${key}/../x.pdf`, "deliverable")).toBe(false)
  })

  it("cleans file names and reads media tolerantly", () => {
    expect(cleanFilename("C:\\Users\\me\\Guide.pdf")).toBe("Guide.pdf")
    expect(cleanFilename("\u0000")).toBe("file")
    const key = `launch-media/${LAUNCH}/0190a0a0-0000-7000-8000-00000000000b.png`
    expect(parseMedia([{ kind: "image", url: key, alt: "Cover" }, { nope: true }, "x"])).toEqual([
      { kind: "image", url: key, alt: "Cover" },
    ])
    expect(launchMediaPath(LAUNCH, key)).toBe(`/api/launches/${LAUNCH}/media/${mediaName(key)}`)
  })
})

describe("status machine as the services use it", () => {
  it("a save sends a submitted launch back to draft and keeps a paused one paused", () => {
    expect(launchStatusAfter("pending_approval", "save")).toBe("draft")
    expect(launchStatusAfter("admin_review", "save")).toBe("draft")
    expect(launchStatusAfter("paused", "save")).toBe("draft")
    expect(launchStatusAfter("paused", "save", { autoApprove: true })).toBe("paused")
    expect(launchStatusAfter("live", "save")).toBeNull()
    expect(launchStatusAfter("ended", "save")).toBeNull()
  })

  it("approvals move draft → pending → review or live; the collab follows", () => {
    expect(launchStatusAfter("draft", "approve", { allMembersApproved: false })).toBe(
      "pending_approval",
    )
    expect(launchStatusAfter("pending_approval", "approve", { allMembersApproved: true })).toBe(
      "admin_review",
    )
    expect(
      launchStatusAfter("pending_approval", "approve", {
        allMembersApproved: true,
        autoApprove: true,
      }),
    ).toBe("live")
    expect(collabStageForLaunch("building", "pending_approval")).toBe("launch_review")
    expect(collabStageForLaunch("launch_review", "draft")).toBe("building")
    expect(collabStageForLaunch("launch_review", "live")).toBe("live")
    expect(collabStageForLaunch("live", "paused")).toBeNull()
  })
})
