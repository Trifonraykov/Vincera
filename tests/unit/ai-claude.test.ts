import Anthropic from "@anthropic-ai/sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  createAnthropicTransport,
  generateStructured,
  generateText,
  parseJson,
} from "@/lib/ai/claude"
import { FAKE_AI_MARKERS } from "@/lib/ai/fake"
import { definePrompt } from "@/lib/ai/prompts"
import type { ClaudeRequest, ClaudeResponse, ClaudeTransport } from "@/lib/ai/types"

import { stubServiceEnv } from "../helpers/service-env"

const briefSchema = z.object({
  title: z.string().min(3).max(80),
  topics: z.array(z.string()).min(1).max(5),
  format: z.enum(["app", "tool", "template"]),
  targetPriceCents: z.number().int().min(100).max(100_000),
})
type Brief = z.infer<typeof briefSchema>

const emptyBrief: Brief = { title: "", topics: [], format: "tool", targetPriceCents: 0 }
const validBrief: Brief = {
  title: "Budget tracker",
  topics: ["finance"],
  format: "app",
  targetPriceCents: 1900,
}

const base = {
  use: "idea_brief" as const,
  promptVersion: "idea_brief@v1",
  system: "Draft an idea brief.",
  prompt: "Comments: people want a budget tracker.",
  schema: briefSchema,
  fallback: emptyBrief,
}

/** A transport that replays the given replies in order (an Error is thrown). */
function scripted(...replies: (Partial<ClaudeResponse> | Error)[]) {
  const calls: ClaudeRequest[] = []
  const transport: ClaudeTransport = async (request) => {
    calls.push(request)
    const reply = replies.shift()
    if (!reply) throw new Error("unexpected extra call")
    if (reply instanceof Error) throw reply
    return { text: "", stopReason: "end_turn", model: "claude-test", ...reply }
  }
  return { transport, calls }
}

beforeEach(() => stubServiceEnv())

describe("generateStructured", () => {
  it("returns validated data with metadata on the first valid reply", async () => {
    const { transport, calls } = scripted({ text: JSON.stringify(validBrief) })
    const result = await generateStructured(base, { transport })

    expect(result).toMatchObject({
      ok: true,
      data: validBrief,
      use: "idea_brief",
      promptVersion: "idea_brief@v1",
      attempts: 1,
      model: "claude-test",
    })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(calls[0]).toMatchObject({
      model: "claude-opus-5-5",
      system: base.system,
      prompt: base.prompt,
      schema: briefSchema,
    })
  })

  it("retries once when the output fails validation", async () => {
    const { transport, calls } = scripted(
      { text: JSON.stringify({ ...validBrief, format: "spaceship" }) },
      { text: JSON.stringify(validBrief) },
    )
    const result = await generateStructured(base, { transport })
    expect(result).toMatchObject({ ok: true, data: validBrief, attempts: 2 })
    expect(calls).toHaveLength(2)
  })

  it("falls back after two invalid outputs", async () => {
    const { transport, calls } = scripted({ text: "not json" }, { text: '{"title": 42}' })
    const result = await generateStructured(base, { transport })
    expect(result).toMatchObject({
      ok: false,
      fallback: emptyBrief,
      reason: "invalid_output",
      attempts: 2,
    })
    expect(calls).toHaveLength(2)
  })

  it("never throws: API errors return the fallback without a second call", async () => {
    const { transport, calls } = scripted(new Error("529 overloaded"))
    const result = await generateStructured(base, { transport })
    expect(result).toMatchObject({ ok: false, reason: "api_error", attempts: 1 })
    expect(calls).toHaveLength(1)
  })

  it("does not retry a refusal", async () => {
    const { transport, calls } = scripted({ stopReason: "refusal" })
    const result = await generateStructured(base, { transport })
    expect(result).toMatchObject({ ok: false, reason: "refusal", fallback: emptyBrief })
    expect(calls).toHaveLength(1)
  })

  it("accepts JSON wrapped in a code fence", async () => {
    const { transport } = scripted({ text: "```json\n" + JSON.stringify(validBrief) + "\n```" })
    const result = await generateStructured(base, { transport })
    expect(result.ok).toBe(true)
  })

  describe("fake transport (AI service not configured)", () => {
    it("produces deterministic, schema-valid output", async () => {
      const first = await generateStructured(base)
      const second = await generateStructured(base)
      expect(first.ok).toBe(true)
      if (!first.ok || !second.ok) return
      expect(briefSchema.parse(first.data)).toEqual(first.data)
      expect(second.data).toEqual(first.data)
      expect(first.model).toBe("fake-claude")
    })

    it.each([
      [FAKE_AI_MARKERS.invalid, "invalid_output", 2],
      [FAKE_AI_MARKERS.refusal, "refusal", 1],
      [FAKE_AI_MARKERS.error, "api_error", 1],
    ] as const)("exercises the fallback path with %s", async (marker, reason, attempts) => {
      const result = await generateStructured({ ...base, prompt: `${base.prompt} ${marker}` })
      expect(result).toMatchObject({ ok: false, reason, attempts, fallback: emptyBrief })
    })
  })
})

describe("generateText", () => {
  it("returns trimmed text, and the fallback for an empty reply", async () => {
    const ok = await generateText(
      { ...base, fallback: "" },
      { transport: scripted({ text: "  Great match.  " }).transport },
    )
    expect(ok).toMatchObject({ ok: true, data: "Great match." })

    const empty = await generateText(
      { ...base, fallback: "n/a" },
      { transport: scripted({ text: " " }, { text: "" }).transport },
    )
    expect(empty).toMatchObject({ ok: false, fallback: "n/a", reason: "invalid_output" })
  })
})

describe("parseJson", () => {
  it("parses plain or fenced JSON and returns undefined otherwise", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseJson("```\n[1,2]\n```")).toEqual([1, 2])
    expect(parseJson("Here you go: {")).toBeUndefined()
  })
})

describe("definePrompt", () => {
  it("enforces <use>@v<n> versions", () => {
    const render = (input: { comments: string }) => input.comments
    expect(
      definePrompt({ use: "idea_brief", version: "idea_brief@v2", system: "", render }),
    ).toBeTruthy()
    expect(() => definePrompt({ use: "idea_brief", version: "v2", system: "", render })).toThrow()
    expect(() =>
      definePrompt({ use: "idea_brief", version: "launch_kit@v1", system: "", render }),
    ).toThrow()
  })
})

describe("createAnthropicTransport", () => {
  function clientReturning(body: unknown) {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(body))
    const client = new Anthropic({ apiKey: "sk-ant-test", fetch: fetchMock, maxRetries: 0 })
    return { client, fetchMock }
  }

  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: JSON.stringify(validBrief) },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  }

  it("requests structured output with server-side refusal fallback and reads text blocks", async () => {
    const { client, fetchMock } = clientReturning(message)
    const response = await createAnthropicTransport(client)({
      model: "claude-opus-5-5",
      system: "sys",
      prompt: "hello",
      maxTokens: 1000,
      timeoutMs: 5000,
      effort: "low",
      schema: briefSchema,
    })

    expect(response).toEqual({
      text: JSON.stringify(validBrief),
      stopReason: "end_turn",
      model: "claude-opus-5-5",
    })
    const [, init] = fetchMock.mock.calls[0] ?? []
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 1000,
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema" } },
    })
    expect(new Headers(init?.headers).get("anthropic-beta")).toContain(
      "server-side-fallback-2026-07-01",
    )
  })

  it("omits the fallback for models that do not support it", async () => {
    const { client, fetchMock } = clientReturning({ ...message, model: "claude-haiku-4-5" })
    await createAnthropicTransport(client)({
      model: "claude-haiku-4-5",
      system: "sys",
      prompt: "hello",
      maxTokens: 100,
      timeoutMs: 5000,
    })
    const [, init] = fetchMock.mock.calls[0] ?? []
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty("fallbacks")
    expect(body).not.toHaveProperty("output_config")
  })
})
