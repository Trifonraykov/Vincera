import { describe, expect, it } from "vitest"

import {
  filterCounts,
  filterLabel,
  nextStatus,
  ownerActions,
  parseSupplyFilter,
  refusalMessage,
  statusesAllowing,
  statusesForFilter,
  statusExplanation,
  statusLabel,
} from "@/lib/supply/lifecycle"

/** The idea and product lifecycle (CLAUDE.md §19.24 "Ideas and products", §19.25). */

describe("owner actions per status", () => {
  it("lets owners edit drafts and published rows, and nothing in a collab or launched", () => {
    expect(ownerActions("idea", "draft")).toEqual(["edit", "publish", "archive"])
    expect(ownerActions("idea", "open")).toEqual(["edit", "archive"])
    expect(ownerActions("idea", "in_collab")).toEqual([])
    expect(ownerActions("idea", "launched")).toEqual([])
    expect(ownerActions("idea", "archived")).toEqual(["restore"])
    expect(ownerActions("product", "seeking")).toEqual(["edit", "archive"])
    expect(ownerActions("product", "in_collab")).toEqual([])
  })

  it("rejects a status of the other kind", () => {
    expect(() => ownerActions("idea", "seeking")).toThrow('"seeking" is not a idea status')
    expect(() => ownerActions("product", "open")).toThrow()
  })
})

describe("transitions", () => {
  it("publishes drafts, archives drafts and published rows, restores archived ones as drafts", () => {
    expect(nextStatus("idea", "draft", "publish")).toBe("open")
    expect(nextStatus("product", "draft", "publish")).toBe("seeking")
    expect(nextStatus("idea", "open", "archive")).toBe("archived")
    expect(nextStatus("idea", "draft", "archive")).toBe("archived")
    expect(nextStatus("product", "archived", "restore")).toBe("draft")
    expect(nextStatus("idea", "open", "edit")).toBe("open")
  })

  it("refuses everything else", () => {
    expect(nextStatus("idea", "open", "publish")).toBeNull()
    expect(nextStatus("idea", "archived", "publish")).toBeNull()
    expect(nextStatus("idea", "archived", "edit")).toBeNull()
    expect(nextStatus("idea", "in_collab", "archive")).toBeNull()
    expect(nextStatus("product", "launched", "edit")).toBeNull()
    expect(nextStatus("product", "seeking", "restore")).toBeNull()
  })

  it("lists the statuses each action may start from (for conditional updates)", () => {
    expect(statusesAllowing("idea", "publish")).toEqual(["draft"])
    expect(statusesAllowing("idea", "archive")).toEqual(["draft", "open"])
    expect(statusesAllowing("product", "archive")).toEqual(["draft", "seeking"])
    expect(statusesAllowing("product", "restore")).toEqual(["archived"])
    expect(statusesAllowing("product", "edit")).toEqual(["draft", "seeking"])
  })

  it("explains refusals in plain language", () => {
    expect(refusalMessage("idea", "in_collab", "edit")).toBe(
      "This idea is part of a collab, so it can't be changed.",
    )
    expect(refusalMessage("product", "launched", "archive")).toBe(
      "This product has launched, so it can't be changed.",
    )
    expect(refusalMessage("idea", "archived", "edit")).toBe(
      "This idea is archived. Restore it to edit it.",
    )
    expect(refusalMessage("idea", "open", "publish")).toBe("This idea is already published.")
    expect(refusalMessage("product", "archived", "archive")).toBe(
      "This product is already archived.",
    )
    expect(refusalMessage("idea", "open", "restore")).toBe("Only archived ideas can be restored.")
  })
})

describe("labels", () => {
  it("names statuses per kind and says who sees them", () => {
    expect(statusLabel("idea", "open")).toBe("Open")
    expect(statusLabel("product", "seeking")).toBe("Seeking creators")
    expect(statusLabel("product", "in_collab")).toBe("In a collab")
    expect(statusExplanation("idea", "draft")).toContain("Only you can see this draft")
    expect(statusExplanation("idea", "open")).toContain("Builders can find this idea")
    expect(statusExplanation("product", "seeking")).toContain("Creators can find this product")
    expect(statusExplanation("product", "archived")).toContain("hidden from creators")
  })
})

describe("list filters", () => {
  it("parses ?status= and falls back to all", () => {
    expect(parseSupplyFilter("draft")).toBe("draft")
    expect(parseSupplyFilter(["live", "draft"])).toBe("live")
    expect(parseSupplyFilter("nope")).toBe("all")
    expect(parseSupplyFilter(undefined)).toBe("all")
  })

  it("maps filters to statuses; all leaves archived out", () => {
    expect(statusesForFilter("idea", "all")).toEqual(["draft", "open", "in_collab", "launched"])
    expect(statusesForFilter("idea", "live")).toEqual(["open"])
    expect(statusesForFilter("product", "live")).toEqual(["seeking"])
    expect(statusesForFilter("product", "archived")).toEqual(["archived"])
    expect(filterLabel("idea", "live")).toBe("Open")
    expect(filterLabel("product", "live")).toBe("Seeking")
  })

  it("counts per filter from per-status counts", () => {
    expect(
      filterCounts("product", { draft: 2, seeking: 3, in_collab: 1, launched: 0, archived: 4 }),
    ).toEqual({ all: 6, draft: 2, live: 3, in_collab: 1, launched: 0, archived: 4 })
    expect(filterCounts("idea", {})).toEqual({
      all: 0,
      draft: 0,
      live: 0,
      in_collab: 0,
      launched: 0,
      archived: 0,
    })
  })
})
