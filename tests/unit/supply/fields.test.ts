import { describe, expect, it } from "vitest"
import { z } from "zod"

import { ideaFormSchema, ideaPublishProblems } from "@/lib/ideas/fields"
import { productFormSchema, productPublishProblems } from "@/lib/products/fields"

/** The idea and product form schemas (§5; CLAUDE.md §19.25), shared by forms and actions. */

function errorsOf(result: { success: false; error: z.ZodError }) {
  return z.flattenError(result.error).fieldErrors as Record<string, string[] | undefined>
}

describe("idea form", () => {
  it("parses a typical submission: trimmed text, price in cents, normalised topics", () => {
    const parsed = ideaFormSchema.parse({
      title: "  Budget   planner for students ",
      problem: "Line one\r\nLine two  ",
      audienceEvidence: "",
      format: "template",
      targetPrice: "19,99",
      topics: "#Budgeting, students, budgeting",
      intent: "publish",
    })
    expect(parsed).toEqual({
      title: "Budget planner for students",
      problem: "Line one\nLine two",
      audienceEvidence: null,
      format: "template",
      targetPrice: 1999,
      topics: ["budgeting", "students"],
      intent: "publish",
    })
  })

  it("defaults the intent to save and accepts a missing price", () => {
    const parsed = ideaFormSchema.parse({ title: "Idea", format: "app" })
    expect(parsed).toMatchObject({ intent: "save", targetPrice: null, topics: [], problem: null })
  })

  it("explains what is wrong, per field", () => {
    const result = ideaFormSchema.safeParse({
      title: "   ",
      format: "",
      targetPrice: "19.999",
      topics: "a, b, c, d, e, f, g, h, i",
      problem: "x".repeat(2001),
    })
    expect(result.success).toBe(false)
    if (result.success) return
    const errors = errorsOf(result)
    expect(errors.title).toEqual(["Give your idea a title."])
    expect(errors.format).toEqual(["Pick a format."])
    expect(errors.targetPrice).toEqual(["Use at most two decimals, like 19.99."])
    expect(errors.topics).toEqual(["Pick at most 8 topics."])
    expect(errors.problem).toEqual(["Keep the problem under 2,000 characters."])
  })

  it("caps the title and the price", () => {
    const result = ideaFormSchema.safeParse({
      title: "t".repeat(121),
      format: "tool",
      targetPrice: "20000",
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(errorsOf(result).title).toEqual(["Keep the title under 120 characters."])
    expect(errorsOf(result).targetPrice).toEqual(["Keep the price at €10,000 or less."])
  })

  it("needs a problem and a topic before publishing", () => {
    expect(ideaPublishProblems({ problem: null, topics: [] })).toEqual({
      problem: ["Describe the problem before publishing."],
      topics: ["Add at least one topic before publishing, so builders can find it."],
    })
    expect(ideaPublishProblems({ problem: "Why", topics: ["x"] })).toEqual({})
  })
})

describe("product form", () => {
  it("parses a typical submission", () => {
    const parsed = productFormSchema.parse({
      title: "Invoice generator",
      description: "**Fast** invoices.\r\n\r\n- PDF",
      targetUser: "  Freelance   designers ",
      stage: "beta",
      demoUrl: "demo.example.com/app",
      format: "tool",
      targetPrice: "29",
      topics: "Freelancing",
      preferredSplitBuilderPct: "60 %",
      exclusivity: "on",
    })
    expect(parsed).toEqual({
      title: "Invoice generator",
      description: "**Fast** invoices.\n\n- PDF",
      targetUser: "Freelance designers",
      stage: "beta",
      demoUrl: "https://demo.example.com/app",
      format: "tool",
      targetPrice: 2900,
      topics: ["freelancing"],
      preferredSplitBuilderPct: 60,
      exclusivity: true,
      intent: "save",
    })
  })

  it("leaves optional fields empty and exclusivity off when the box is not ticked", () => {
    const parsed = productFormSchema.parse({ title: "P", format: "app", stage: "idea" })
    expect(parsed).toMatchObject({
      description: null,
      targetUser: null,
      demoUrl: null,
      targetPrice: null,
      preferredSplitBuilderPct: null,
      exclusivity: false,
    })
  })

  it("refuses non-web links, impossible splits and unknown stages", () => {
    const result = productFormSchema.safeParse({
      title: "P",
      format: "app",
      stage: "alpha",
      demoUrl: "javascript:alert(1)",
      preferredSplitBuilderPct: "101",
    })
    expect(result.success).toBe(false)
    if (result.success) return
    const errors = errorsOf(result)
    expect(errors.stage).toEqual(["Pick the stage it's at."])
    expect(errors.demoUrl).toEqual(["Enter a web address, like https://example.com."])
    expect(errors.preferredSplitBuilderPct).toEqual(["Enter a whole percentage from 0 to 100."])
    expect(
      productFormSchema.safeParse({
        title: "P",
        format: "app",
        stage: "idea",
        preferredSplitBuilderPct: "33.5",
      }).success,
    ).toBe(false)
  })

  it("needs a description and a topic before publishing", () => {
    expect(productPublishProblems({ description: null, topics: [] })).toEqual({
      description: ["Describe the product before publishing."],
      topics: ["Add at least one topic before publishing, so creators can find it."],
    })
    expect(productPublishProblems({ description: "It works", topics: ["x"] })).toEqual({})
  })
})
