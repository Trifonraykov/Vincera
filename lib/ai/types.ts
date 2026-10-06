import type { z } from "zod"

import type { AiUse } from "./prompts"

/** Output effort for models that support it (`output_config.effort`). */
export type AiEffort = "low" | "medium" | "high" | "xhigh" | "max"

/** One call to the model, independent of how it is carried out (SDK, fake, test double). */
export type ClaudeRequest = {
  model: string
  system: string
  prompt: string
  maxTokens: number
  timeoutMs: number
  effort?: AiEffort
  /** Present for structured output: the reply must be JSON matching this schema. */
  schema?: z.ZodType
  /**
   * Only used by the fake transport (§19.3): builds a realistic reply from the prompt's typed
   * input (a string for text, a JSON value for structured output). Never sent to the API.
   */
  fakeOutput?: () => unknown
}

export type ClaudeResponse = {
  /** Concatenated text blocks of the reply. */
  text: string
  /** e.g. `end_turn`, `max_tokens`, `refusal`. */
  stopReason: string | null
  /** The model that actually served the reply (may differ after a server-side fallback). */
  model: string
}

/** Carries out a request. Throws on transport / API errors. */
export type ClaudeTransport = (request: ClaudeRequest) => Promise<ClaudeResponse>

export type AiFailureReason = "invalid_output" | "refusal" | "api_error"

type AiMeta = {
  use: AiUse
  promptVersion: string
  latencyMs: number
  /** Model calls made (2 when the first output was invalid and was retried). */
  attempts: number
  model: string
}

export type AiResult<T> =
  (AiMeta & { ok: true; data: T }) | (AiMeta & { ok: false; fallback: T; reason: AiFailureReason })
