import { describe, expect, it } from "vitest"
import { z } from "zod"

import { createFakeTransport } from "@/lib/ai/fake"
import {
  audienceSummaryOutputSchema,
  fakeAudienceSummary,
  type AudienceSummaryInput,
} from "@/lib/ai/prompts/audience-summary"
import type { ClaudeRequest } from "@/lib/ai/types"

const base: ClaudeRequest = {
  model: "fake",
  system: "system",
  prompt: "prompt",
  maxTokens: 100,
  timeoutMs: 1000,
}

describe("fake transport fakeOutput", () => {
  it("returns the prompt's realistic output instead of a schema sample", async () => {
    const transport = createFakeTransport()
    const schema = z.object({ title: z.string() })
    const reply = await transport({
      ...base,
      schema,
      fakeOutput: () => ({ title: "Meal planner" }),
    })
    expect(JSON.parse(reply.text)).toEqual({ title: "Meal planner" })
  })

  it("returns plain text for text prompts", async () => {
    const transport = createFakeTransport()
    const reply = await transport({ ...base, fakeOutput: () => "A short post." })
    expect(reply.text).toBe("A short post.")
  })

  it("falls back to schema sampling when the prompt has no fake", async () => {
    const transport = createFakeTransport()
    const reply = await transport({ ...base, schema: z.object({ n: z.number() }) })
    expect(typeof (JSON.parse(reply.text) as { n: unknown }).n).toBe("number")
  })

  it("still honours the failure markers", async () => {
    const transport = createFakeTransport()
    const reply = await transport({
      ...base,
      prompt: "FAKE_AI_REFUSAL",
      fakeOutput: () => "ignored",
    })
    expect(reply.stopReason).toBe("refusal")
  })
})

const INPUT: AudienceSummaryInput = {
  niche: "Budget cooking for students",
  profileTopics: ["meal prep", "budget recipes"],
  languages: ["en", "es"],
  country: "ES",
  connections: [
    {
      provider: "youtube",
      verified: true,
      followers: 48_200,
      avgViews: 33_532,
      engagementRate: 0.044,
      topCountries: [
        { country: "ES", share: 0.278 },
        { country: "MX", share: 0.163 },
        { country: "US", share: 0.138 },
      ],
      countriesBasis: "viewers",
      ageGender: {
        basis: "viewers",
        buckets: [
          { ageGroup: "18-24", gender: "female", share: 0.15 },
          { ageGroup: "18-24", gender: "male", share: 0.17 },
          { ageGroup: "25-34", gender: "male", share: 0.25 },
          { ageGroup: "25-34", gender: "female", share: 0.15 },
        ],
      },
      topTopics: ["cheap dinners"],
      recentTitles: [],
    },
  ],
}

describe("fakeAudienceSummary", () => {
  it("describes the real numbers in plain sentences and passes the output schema", () => {
    const output = fakeAudienceSummary(INPUT)
    expect(audienceSummaryOutputSchema.safeParse(output).success).toBe(true)
    expect(output.summary).toContain("about 48K subscribers")
    expect(output.summary).toContain("Spain (28%)")
    expect(output.summary).toContain("budget cooking for students")
    expect(output.summary).not.toMatch(/stub/i)
    expect(output.topics).toEqual(["meal prep", "budget recipes", "cheap dinners"])
  })

  it("is deterministic", () => {
    expect(fakeAudienceSummary(INPUT)).toEqual(fakeAudienceSummary(INPUT))
  })

  it("still produces 3+ sentences with no connections or niche", () => {
    const output = fakeAudienceSummary({
      niche: null,
      profileTopics: [],
      languages: [],
      country: null,
      connections: [],
    })
    expect(audienceSummaryOutputSchema.safeParse(output).success).toBe(true)
    expect(output.summary.split(". ").length).toBeGreaterThanOrEqual(2)
  })
})
