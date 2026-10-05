import { createHash } from "node:crypto"

import { z } from "zod"

import type { ClaudeRequest, ClaudeResponse, ClaudeTransport } from "./types"

/**
 * Deterministic stand-ins for Claude and Voyage (§19.3), used when the `ai` / `embeddings`
 * services are fake. Same input, same output, no network.
 *
 * Structured requests get a JSON value generated from the request's Zod schema, so the real
 * parsing and validation code runs. Markers in the prompt force the failure paths:
 * - `FAKE_AI_INVALID`: the reply is not valid JSON (validation fails, retry, then fallback);
 * - `FAKE_AI_REFUSAL`: the reply is a refusal (fallback without retry);
 * - `FAKE_AI_ERROR`: the transport throws, like a network or API error (fallback).
 */

export const FAKE_AI_MARKERS = {
  invalid: "FAKE_AI_INVALID",
  refusal: "FAKE_AI_REFUSAL",
  error: "FAKE_AI_ERROR",
} as const

export const FAKE_MODEL = "fake-claude"

export function createFakeTransport(): ClaudeTransport {
  return async (request: ClaudeRequest): Promise<ClaudeResponse> => {
    if (request.prompt.includes(FAKE_AI_MARKERS.error)) {
      throw new Error("Fake AI transport error (FAKE_AI_ERROR marker in prompt)")
    }
    if (request.prompt.includes(FAKE_AI_MARKERS.refusal)) {
      return { text: "", stopReason: "refusal", model: FAKE_MODEL }
    }
    if (request.prompt.includes(FAKE_AI_MARKERS.invalid)) {
      return {
        text: "Sorry, here is some prose instead of JSON.",
        stopReason: "end_turn",
        model: FAKE_MODEL,
      }
    }

    const seed = `${request.system}\n${request.prompt}`
    if (request.schema) {
      const jsonSchema: unknown = z.toJSONSchema(request.schema, {
        io: "input",
        unrepresentable: "any",
      })
      const value = sampleFromJsonSchema(jsonSchema, createRandom(seed))
      return { text: JSON.stringify(value), stopReason: "end_turn", model: FAKE_MODEL }
    }
    return { text: fakeText(request.prompt, seed), stopReason: "end_turn", model: FAKE_MODEL }
  }
}

function fakeText(prompt: string, seed: string): string {
  const words = prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 24).join(" ")
  return `[Stub reply ${digest(seed).slice(0, 8)}] This text was generated without calling Claude. Prompt began: "${words}"`
}

// --- JSON Schema sampling -------------------------------------------------------------------

type Random = { next(): number; pick<T>(items: readonly T[]): T | undefined }
type Node = Record<string, unknown>

function createRandom(seed: string): Random {
  // mulberry32 seeded from the first 4 bytes of sha256(seed).
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0)
  const next = () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, pick: (items) => items[Math.floor(next() * items.length)] }
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(node: Node, key: string): number | undefined {
  const value = node[key]
  return typeof value === "number" ? value : undefined
}

const WORDS = [
  "audience",
  "builder",
  "creator",
  "launch",
  "template",
  "toolkit",
  "insight",
  "habit",
  "workflow",
  "studio",
] as const

/** A value satisfying the common JSON Schema keywords Zod emits (best effort, deterministic). */
export function sampleFromJsonSchema(
  schema: unknown,
  random: Random,
  root: unknown = schema,
  name = "value",
  depth = 0,
): unknown {
  if (!isNode(schema) || depth > 12) return null

  const ref = schema.$ref
  if (typeof ref === "string")
    return sampleFromJsonSchema(resolveRef(root, ref), random, root, name, depth + 1)
  if ("const" in schema) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]

  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key]
    if (Array.isArray(options) && options.length > 0) {
      const nonNull = options.find((o) => !(isNode(o) && o.type === "null")) ?? options[0]
      return sampleFromJsonSchema(nonNull, random, root, name, depth + 1)
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return sampleFromJsonSchema(schema.allOf[0], random, root, name, depth + 1)
  }

  const types = Array.isArray(schema.type) ? schema.type.filter((t) => t !== "null") : [schema.type]
  switch (types[0]) {
    case "object":
      return sampleObject(schema, random, root, depth)
    case "array":
      return sampleArray(schema, random, root, name, depth)
    case "string":
      return sampleString(schema, random, name)
    case "integer":
    case "number":
      return sampleNumber(schema, random, types[0] === "integer")
    case "boolean":
      return random.next() < 0.5
    case "null":
      return null
    default:
      return isNode(schema.properties) ? sampleObject(schema, random, root, depth) : `stub ${name}`
  }
}

function resolveRef(root: unknown, ref: string): unknown {
  if (ref === "#") return root
  if (!ref.startsWith("#/")) return undefined
  return ref
    .slice(2)
    .split("/")
    .reduce<unknown>(
      (node, part) =>
        isNode(node) ? node[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined,
      root,
    )
}

function sampleObject(
  schema: Node,
  random: Random,
  root: unknown,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const properties = isNode(schema.properties) ? schema.properties : {}
  for (const [key, child] of Object.entries(properties)) {
    out[key] = sampleFromJsonSchema(child, random, root, key, depth + 1)
  }
  return out
}

function sampleArray(
  schema: Node,
  random: Random,
  root: unknown,
  name: string,
  depth: number,
): unknown[] {
  const min = num(schema, "minItems") ?? 1
  const max = num(schema, "maxItems") ?? Math.max(min, 3)
  const count = Math.min(Math.max(min, 2), max)
  return Array.from({ length: count }, (_, i) =>
    sampleFromJsonSchema(schema.items, random, root, `${name} ${i + 1}`, depth + 1),
  )
}

function sampleString(schema: Node, random: Random, name: string): string {
  switch (schema.format) {
    case "email":
      return "stub@example.com"
    case "uri":
    case "url":
      return "https://example.com/stub"
    case "uuid":
      return "01890000-0000-7000-8000-000000000000"
    case "date-time":
      return "2026-01-01T00:00:00.000Z"
    case "date":
      return "2026-01-01"
  }
  const min = num(schema, "minLength") ?? 0
  const max = num(schema, "maxLength") ?? Number.POSITIVE_INFINITY
  let text = `Stub ${name.replace(/_/g, " ")} ${random.pick(WORDS) ?? "value"}`
  while (text.length < min) text += ` ${random.pick(WORDS) ?? "more"}`
  return text.slice(0, max)
}

function sampleNumber(schema: Node, random: Random, integer: boolean): number {
  const exclusiveMin = num(schema, "exclusiveMinimum")
  const exclusiveMax = num(schema, "exclusiveMaximum")
  const min =
    num(schema, "minimum") ??
    (exclusiveMin !== undefined ? exclusiveMin + (integer ? 1 : 0.001) : 0)
  const max =
    num(schema, "maximum") ??
    (exclusiveMax !== undefined ? exclusiveMax - (integer ? 1 : 0.001) : min + 100)
  const value = min + random.next() * Math.max(0, max - min)
  return integer
    ? Math.min(Math.max(Math.round(value), Math.ceil(min)), Math.floor(max))
    : Number(value.toFixed(4))
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

// --- Embeddings ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have i in is it its of on or our so that the their them they this to was we were what when which who will with you your".split(
    " ",
  ),
)

/** 32-bit FNV-1a hash. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Deterministic hashed bag-of-words vector, L2-normalised (§19.3). Texts sharing words get a
 * positive cosine similarity, so matching behaves plausibly with fake embeddings.
 */
export function fakeEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  const tokens = (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((token) => token.length > 1 && !STOPWORDS.has(token))
  for (const token of tokens.length > 0 ? tokens : ["<empty>"]) {
    const index = fnv1a(token) % dimensions
    vector[index] = (vector[index] ?? 0) + 1
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  return vector.map((v) => v / norm)
}
