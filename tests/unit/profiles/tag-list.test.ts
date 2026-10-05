import { describe, expect, it } from "vitest"

import { addTags, cleanTag, splitTyped, submittedTags } from "@/components/profiles/tag-list"
import { parseTopicsInput } from "@/lib/social/summary-form"

/** The tag input's pure logic (components/profiles/tag-list.ts; CLAUDE.md §19.17). */

const topic = (tag: string) => parseTopicsInput(tag)[0] ?? ""

describe("splitTyped", () => {
  it("keeps typing until a comma or line break ends a tag", () => {
    expect(splitTyped("Web apps")).toEqual({ finished: [], draft: "Web apps" })
    expect(splitTyped("Web apps,")).toEqual({ finished: ["Web apps"], draft: "" })
    expect(splitTyped("Web apps, AI tools")).toEqual({ finished: ["Web apps"], draft: "AI tools" })
    expect(splitTyped("a\nb, c")).toEqual({ finished: ["a", "b"], draft: "c" })
  })
})

describe("addTags", () => {
  it("cleans, normalises and drops empty and duplicate tags (ignoring case)", () => {
    expect(
      addTags(["TypeScript"], ["  next.js ", "typescript", "", "Next.js"], { max: 12 }),
    ).toEqual({ tags: ["TypeScript", "next.js"], added: ["next.js"], overflow: [] })
    expect(addTags([], ["Meal  Prep", "#Budget"], { max: 8, normalize: topic })).toEqual({
      tags: ["meal prep", "budget"],
      added: ["meal prep", "budget"],
      overflow: [],
    })
  })

  it("stops at the limit and reports what did not fit", () => {
    expect(addTags(["a", "b"], ["c", "d", "a"], { max: 3 })).toEqual({
      tags: ["a", "b", "c"],
      added: ["c"],
      overflow: ["d"],
    })
  })
})

describe("submittedTags", () => {
  it("sends the tags plus the text still being typed", () => {
    expect(submittedTags(["Web apps"], " AI  tools ")).toBe("Web apps, AI tools")
    expect(submittedTags(["Web apps"], "   ")).toBe("Web apps")
    expect(submittedTags([], "")).toBe("")
    expect(cleanTag(" #Yoga ", topic)).toBe("yoga")
  })
})
