import { beforeEach, describe, expect, it, vi } from "vitest"

import { EMBEDDING_DIMENSIONS, embed, EmbeddingError } from "@/lib/ai/embed"
import { fakeEmbedding } from "@/lib/ai/fake"

import { stubServiceEnv } from "../helpers/service-env"

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0))
const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0)

describe("fakeEmbedding", () => {
  it("is deterministic, 1024-dim and L2-normalised", () => {
    const a = fakeEmbedding("Notion templates for productive students", EMBEDDING_DIMENSIONS)
    const b = fakeEmbedding("Notion templates for productive students", EMBEDDING_DIMENSIONS)
    expect(a).toHaveLength(1024)
    expect(a).toEqual(b)
    expect(norm(a)).toBeCloseTo(1, 10)
  })

  it("ignores case, punctuation and stopwords", () => {
    expect(fakeEmbedding("The FITNESS app!", 1024)).toEqual(fakeEmbedding("fitness app", 1024))
  })

  it("gives related texts a higher similarity than unrelated ones", () => {
    const query = fakeEmbedding("budget tracker for freelancers", 1024)
    const related = fakeEmbedding("a budget tracker app for freelancers and creators", 1024)
    const unrelated = fakeEmbedding("vegan baking recipes", 1024)
    expect(cosine(query, related)).toBeGreaterThan(0.5)
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated))
  })

  it("returns a unit vector even when no word survives filtering", () => {
    const vector = fakeEmbedding("a an the !!!", 1024)
    expect(norm(vector)).toBeCloseTo(1, 10)
    expect(vector.every(Number.isFinite)).toBe(true)
  })
})

describe("embed", () => {
  beforeEach(() => stubServiceEnv())

  it("uses the fake when embeddings are not configured", async () => {
    const vectors = await embed(["hello world", "goodbye world"], "document")
    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toEqual(fakeEmbedding("hello world", 1024))
  })

  it("returns [] for no input and rejects empty text", async () => {
    await expect(embed([], "query")).resolves.toEqual([])
    await expect(embed(["  "], "query")).rejects.toBeInstanceOf(EmbeddingError)
  })

  describe("Voyage", () => {
    beforeEach(() => stubServiceEnv({ VOYAGE_API_KEY: "pa-test", VOYAGE_MODEL: "voyage-test" }))

    function voyageFetch() {
      return vi.fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] }
        // Reply out of order to prove results are re-sorted by index.
        const data = body.input
          .map((text, index) => ({ index, embedding: fakeEmbedding(text, 1024) }))
          .reverse()
        return Response.json({ object: "list", data, model: "voyage-test" })
      })
    }

    it("sends typed, 1024-dim requests in batches and keeps input order", async () => {
      const fetchMock = voyageFetch()
      const texts = Array.from({ length: 130 }, (_, i) => `text number ${i}`)
      const vectors = await embed(texts, "query", { fetch: fetchMock })

      expect(fetchMock).toHaveBeenCalledTimes(2)
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe("https://api.voyageai.com/v1/embeddings")
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({
        model: "voyage-test",
        input_type: "query",
        output_dimension: 1024,
      })
      expect((body.input as string[]).length).toBe(128)
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer pa-test")
      expect(vectors).toHaveLength(130)
      expect(vectors[129]).toEqual(fakeEmbedding("text number 129", 1024))
    })

    it("rejects malformed responses and HTTP errors", async () => {
      const wrongDims = vi.fn<typeof fetch>(async () =>
        Response.json({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
      )
      await expect(embed(["x"], "document", { fetch: wrongDims })).rejects.toThrow(
        /Unexpected response/,
      )

      const failing = vi.fn<typeof fetch>(async () => new Response("nope", { status: 429 }))
      await expect(embed(["x"], "document", { fetch: failing })).rejects.toThrow(/HTTP 429/)
    })
  })
})
