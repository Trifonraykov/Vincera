import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { EMPTY_IDEA_DEFAULTS, IdeaForm } from "@/components/ideas/idea-form"
import { NewIdea } from "@/components/ideas/new-idea"
import { EMPTY_PRODUCT_DEFAULTS, ProductForm } from "@/components/products/product-form"
import { SupplyStatusFilter } from "@/components/supply/status-filter"
import { SupplyCard } from "@/components/supply/supply-card"

/**
 * Server-rendered supply forms and lists (CLAUDE.md §19.25): what a phone gets before hydration.
 * Labels and hints are wired to the fields, prices use a decimal keyboard, and the buttons match
 * the status (drafts: Save draft + Publish; published: Save changes).
 */

/** Whether one `<tag …>` in `html` carries every attribute (React orders attributes its own way). */
function hasTag(html: string, tag: string, attributes: Record<string, string>): boolean {
  const tags = html.match(new RegExp(`<${tag}\\b[^>]*>`, "g")) ?? []
  return tags.some((found) =>
    Object.entries(attributes).every(([name, value]) => found.includes(`${name}="${value}"`)),
  )
}

describe("IdeaForm", () => {
  it("offers Save draft and Publish on a new idea, with labelled fields", () => {
    const html = renderToStaticMarkup(
      createElement(IdeaForm, { mode: "create", defaults: EMPTY_IDEA_DEFAULTS, briefToken: "tok" }),
    )
    for (const label of [
      "Title",
      "Format",
      "Target price",
      "Problem",
      "Audience evidence",
      "Topics",
    ]) {
      expect(html).toContain(`>${label}`)
    }
    expect(hasTag(html, "button", { name: "intent", value: "save" })).toBe(true)
    expect(hasTag(html, "button", { name: "intent", value: "publish" })).toBe(true)
    expect(html).toContain(">Save draft")
    expect(html).toContain(">Publish")
    expect(html).toContain('type="hidden" name="brief" value="tok"')
    expect(hasTag(html, "input", { name: "targetPrice", inputMode: "decimal" })).toBe(true)
    expect(html).toMatch(/<input[^>]*aria-describedby="[^"]*-title-hint"[^>]*name="title"/)
    expect(html).toContain("data-form-actions")
  })

  it("only saves changes on an open idea, and carries its id", () => {
    const html = renderToStaticMarkup(
      createElement(IdeaForm, {
        mode: "edit",
        ideaId: "0190a000-0000-7000-8000-000000000001",
        status: "open",
        defaults: {
          ...EMPTY_IDEA_DEFAULTS,
          title: "Budget planner",
          format: "template",
          targetPrice: "19",
          topics: ["budgeting"],
        },
      }),
    )
    expect(html).toContain('name="ideaId" value="0190a000-0000-7000-8000-000000000001"')
    expect(html).toContain(">Save changes")
    expect(html).not.toContain('value="publish"')
    expect(html).toContain('value="Budget planner"')
    expect(html).toContain('value="19"')
    expect(html).toContain('name="topics" value="budgeting"')
  })
})

describe("NewIdea", () => {
  it("puts the brief drafter above the form", () => {
    const html = renderToStaticMarkup(createElement(NewIdea))
    expect(html).toContain("Draft it from your audience")
    expect(html).toContain(">Audience comments")
    expect(html).toContain('name="comments"')
    expect(html).toContain(">Draft my idea")
    expect(html.indexOf("Draft my idea")).toBeLessThan(html.indexOf("Save draft"))
  })
})

describe("ProductForm", () => {
  it("has every product field, stage radios and the exclusivity checkbox", () => {
    const html = renderToStaticMarkup(
      createElement(ProductForm, { mode: "create", defaults: EMPTY_PRODUCT_DEFAULTS }),
    )
    for (const label of [
      "Title",
      "Description",
      "Who it&#x27;s for",
      "Format",
      "Demo link",
      "Planned price",
      "Your preferred share",
      "Topics",
      "Exclusive to one creator",
    ]) {
      expect(html).toContain(label)
    }
    for (const stage of ["idea", "prototype", "beta", "live"]) {
      expect(hasTag(html, "input", { type: "radio", name: "stage", value: stage })).toBe(true)
    }
    expect(hasTag(html, "input", { name: "stage", value: "idea", checked: "" })).toBe(true)
    expect(hasTag(html, "input", { type: "checkbox", name: "exclusivity" })).toBe(true)
    expect(hasTag(html, "input", { type: "checkbox", name: "exclusivity", checked: "" })).toBe(
      false,
    )
    expect(hasTag(html, "input", { type: "url", name: "demoUrl" })).toBe(true)
    expect(html).toContain(">Publish")
  })

  it("shows the saved exclusivity and saves changes on a seeking product", () => {
    const html = renderToStaticMarkup(
      createElement(ProductForm, {
        mode: "edit",
        productId: "0190a000-0000-7000-8000-000000000002",
        status: "seeking",
        defaults: { ...EMPTY_PRODUCT_DEFAULTS, title: "Invoices", exclusivity: true },
      }),
    )
    expect(hasTag(html, "input", { type: "checkbox", name: "exclusivity", checked: "" })).toBe(true)
    expect(html).toContain(">Save changes")
    expect(html).toContain('name="productId"')
  })
})

describe("lists", () => {
  it("shows filter chips with counts and marks the current one", () => {
    const html = renderToStaticMarkup(
      createElement(SupplyStatusFilter, {
        kind: "idea",
        basePath: "/app/ideas",
        current: "draft",
        counts: { all: 3, draft: 2, live: 1, in_collab: 0, launched: 0, archived: 0 },
      }),
    )
    expect(html).toContain('aria-label="Filter ideas by status"')
    expect(html).toContain('href="/app/ideas"')
    expect(hasTag(html, "a", { href: "/app/ideas?status=draft", "aria-current": "page" })).toBe(
      true,
    )
    expect(html).toContain('href="/app/ideas?status=live"')
    // Empty filters are left out.
    expect(html).not.toContain("status=archived")
    expect(html).toContain("min-h-11")
  })

  it("links a whole card to the item", () => {
    const html = renderToStaticMarkup(
      createElement(SupplyCard, {
        kind: "product",
        href: "/app/products/1",
        title: "Invoice generator",
        status: "seeking",
        facts: ["Tool", null, "€29"],
        topics: ["freelancing"],
        updatedAt: new Date("2026-10-05T12:00:00.000Z"),
      }),
    )
    expect(html).toContain('href="/app/products/1"')
    expect(html).toContain("Seeking creators")
    expect(html).toContain("Tool · €29")
    expect(html).toContain("Updated 5 Oct 2026")
  })
})
