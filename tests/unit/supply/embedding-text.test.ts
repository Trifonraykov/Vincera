import { describe, expect, it } from "vitest"

import { ideaEmbeddingText, productEmbeddingText } from "@/lib/embeddings/entities"

/** What ideas and products are embedded from (CLAUDE.md §19.24 "Embeddings"). */

describe("embedding texts", () => {
  it("describes an idea by its title, problem, evidence, format and topics", () => {
    expect(
      ideaEmbeddingText({
        title: "Budget planner",
        problem: "Students run out of money.",
        audienceEvidence: null,
        format: "template",
        topics: ["budgeting", "students"],
      }),
    ).toBe(
      "Idea: Budget planner\nProblem: Students run out of money.\nFormat: Template\nTopics: budgeting, students",
    )
  })

  it("describes a product by title, description, target user, stage, format and topics", () => {
    expect(
      productEmbeddingText({
        title: "Invoices",
        description: "Makes PDFs.",
        targetUser: "Freelancers",
        stage: "idea",
        format: "tool",
        topics: [],
      }),
    ).toBe(
      "Product: Invoices\nDescription: Makes PDFs.\nFor: Freelancers\nStage: idea (not built yet)\nFormat: Tool",
    )
  })
})
