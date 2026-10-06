import "server-only"

import Anthropic from "@anthropic-ai/sdk"
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"
import type { z } from "zod"

import { env, isFake } from "@/lib/env"
import { reportError } from "@/lib/observability"

import { createFakeTransport } from "./fake"
import type { AiUse } from "./prompts"
import type {
  AiEffort,
  AiFailureReason,
  AiResult,
  ClaudeRequest,
  ClaudeResponse,
  ClaudeTransport,
} from "./types"

export type { AiResult } from "./types"

/**
 * Claude API wrapper (§7.3). The rules it enforces:
 * - LLM output is validated with Zod. Invalid output is retried once, then the caller's
 *   `fallback` (empty fields) is returned.
 * - It never throws into user flows: API errors, refusals and invalid output all come back as
 *   `{ ok: false, fallback, reason }` and are reported to Sentry.
 * - Every result carries `promptVersion` and `latencyMs`.
 *
 * Emitting the `ai.generated` event (§11: prompt_version, use, latency_ms, accepted_by_user) is
 * the caller's job, because only the caller knows the subject and, later, whether the user
 * accepted the output. Never put prompt text or outputs in event properties.
 */

/** Generous by default: adaptive thinking counts toward max_tokens on current models. */
const DEFAULT_MAX_TOKENS = 16_000
const DEFAULT_TIMEOUT_MS = 60_000

type GenerateOptions = {
  use: AiUse
  /** From the prompt definition in `lib/ai/prompts`, e.g. `idea_brief@v1`. */
  promptVersion: string
  system: string
  prompt: string
  maxTokens?: number
  effort?: AiEffort
  timeoutMs?: number
  /** Realistic output for the fake transport, usually `() => prompt.fake(input)`. */
  fakeOutput?: () => unknown
}

export type GenerateStructuredOptions<S extends z.ZodType> = GenerateOptions & {
  schema: S
  /** Returned when no valid output can be produced (§7.3: "fall back to empty fields"). */
  fallback: z.output<S>
}

export type GenerateTextOptions = GenerateOptions & {
  fallback: string
}

export type ClaudeDeps = {
  /** Override how requests are carried out (tests). Defaults to the SDK, or the fake. */
  transport?: ClaudeTransport
}

export async function generateStructured<S extends z.ZodType>(
  options: GenerateStructuredOptions<S>,
  deps: ClaudeDeps = {},
): Promise<AiResult<z.output<S>>> {
  return run(options, deps, options.schema, (text) => {
    const json = parseJson(text)
    if (json === undefined) return undefined
    const parsed = options.schema.safeParse(json)
    return parsed.success ? parsed.data : undefined
  })
}

export async function generateText(
  options: GenerateTextOptions,
  deps: ClaudeDeps = {},
): Promise<AiResult<string>> {
  return run(options, deps, undefined, (text) => {
    const trimmed = text.trim()
    return trimmed ? trimmed : undefined
  })
}

/** Shared loop: one retry on invalid output, none on API errors (the SDK already retries). */
async function run<T>(
  options: GenerateOptions & { fallback: T },
  deps: ClaudeDeps,
  schema: z.ZodType | undefined,
  accept: (text: string) => T | undefined,
): Promise<AiResult<T>> {
  const transport = deps.transport ?? defaultTransport()
  const request: ClaudeRequest = {
    model: env.ANTHROPIC_MODEL,
    system: options.system,
    prompt: options.prompt,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    effort: options.effort,
    schema,
    fakeOutput: options.fakeOutput,
  }

  const started = performance.now()
  const meta = (attempts: number, model: string) => ({
    use: options.use,
    promptVersion: options.promptVersion,
    latencyMs: Math.round(performance.now() - started),
    attempts,
    model,
  })
  const fail = (attempts: number, model: string, reason: AiFailureReason): AiResult<T> => ({
    ...meta(attempts, model),
    ok: false,
    fallback: options.fallback,
    reason,
  })
  const tags = { ai_use: options.use, prompt_version: options.promptVersion }

  let model = request.model
  for (let attempt = 1; attempt <= 2; attempt++) {
    let response: ClaudeResponse
    try {
      response = await transport(request)
    } catch (error) {
      reportError(error, { tags: { ...tags, ai_failure: "api_error" } })
      return fail(attempt, model, "api_error")
    }
    model = response.model

    if (response.stopReason === "refusal") {
      reportError(new Error("Claude declined the request"), {
        tags: { ...tags, ai_failure: "refusal" },
      })
      return fail(attempt, model, "refusal")
    }

    const data = accept(response.text)
    if (data !== undefined) return { ...meta(attempt, model), ok: true, data }
  }

  reportError(new Error("Claude returned invalid output twice"), {
    tags: { ...tags, ai_failure: "invalid_output" },
  })
  return fail(2, model, "invalid_output")
}

/** JSON from a reply, tolerating a Markdown code fence around it. Undefined if not JSON. */
export function parseJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  try {
    return JSON.parse(fenced?.[1] ?? trimmed) as unknown
  } catch {
    return undefined
  }
}

// --- Transports -----------------------------------------------------------------------------

/**
 * Models that accept the server-side refusal fallback in its `"default"` form: if a safety
 * classifier declines, the API reruns the request on a suitable model within the same call.
 */
const SERVER_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
])

let liveTransport: ClaudeTransport | undefined
let fakeTransport: ClaudeTransport | undefined

function defaultTransport(): ClaudeTransport {
  if (isFake("ai")) return (fakeTransport ??= createFakeTransport())
  return (liveTransport ??= createAnthropicTransport(
    new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
  ))
}

export function createAnthropicTransport(client: Anthropic): ClaudeTransport {
  return async (request: ClaudeRequest): Promise<ClaudeResponse> => {
    const format = request.schema ? zodOutputFormat(request.schema) : undefined
    const outputConfig =
      format || request.effort
        ? {
            ...(format ? { format: { type: "json_schema" as const, schema: format.schema } } : {}),
            ...(request.effort ? { effort: request.effort } : {}),
          }
        : undefined
    const fallback = SERVER_FALLBACK_MODELS.has(request.model)

    const message = await client.beta.messages.create(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
        ...(outputConfig ? { output_config: outputConfig } : {}),
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      },
      { timeout: request.timeoutMs },
    )

    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
    return { text, stopReason: message.stop_reason, model: message.model }
  }
}
