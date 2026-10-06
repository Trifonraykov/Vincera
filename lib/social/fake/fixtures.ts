import "server-only"

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import type { SocialProviderId } from "../types"

/**
 * Recorded provider responses for the fake social providers (§19.3), one JSON file per fixture
 * account under `tests/fixtures/social/<provider>/<account>.json`. The fake transport replays
 * them into the real provider code, so the real request building, Zod parsing and mapping run.
 *
 * File shape (validated here):
 * - `label`, `description`: shown on the fake authorize page.
 * - `oauth.token`: the token endpoint's reply to a code exchange (Instagram: the short-lived token
 *   reply), `oauth.longLived` (Instagram only), `oauth.refresh`: the reply to a refresh. Strings
 *   `{{access_token}}` / `{{refresh_token}}` are replaced with freshly minted fake tokens, whose
 *   lifetimes follow the template's `expires_in` / `refresh_expires_in` /
 *   `refresh_token_expires_in`. A non-2xx `status` records a failure (e.g. a revoked grant).
 * - `responses`: API replies matched by method, URL (no query) and a subset of query params;
 *   the most specific match wins.
 *
 * Files are read on every request (no cache), so edits apply immediately.
 */

const ACCOUNT_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/

const recordedReplySchema = z.object({
  status: z.number().int().min(100).max(599).default(200),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.json(),
})
export type RecordedReply = z.infer<typeof recordedReplySchema>

const recordedResponseSchema = recordedReplySchema.extend({
  method: z.enum(["GET", "POST"]),
  url: z.url(),
  query: z.record(z.string(), z.string()).optional(),
})
export type RecordedResponse = z.infer<typeof recordedResponseSchema>

export const fakeFixtureSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1),
  oauth: z.object({
    token: recordedReplySchema,
    longLived: recordedReplySchema.optional(),
    refresh: recordedReplySchema,
  }),
  responses: z.array(recordedResponseSchema),
})
export type FakeFixture = z.infer<typeof fakeFixtureSchema>

export type FakeAccountSummary = { key: string; label: string; description: string }

/** `tests/fixtures/social`, resolved from the working directory (like `.data/`, §19.3). */
export function defaultFixturesRoot(): string {
  return path.join(process.cwd(), "tests", "fixtures", "social")
}

export function isFakeAccountKey(value: string): boolean {
  return ACCOUNT_KEY.test(value)
}

/** One fixture account, or null when it does not exist. Throws on a malformed file. */
export async function loadFakeFixture(
  provider: SocialProviderId,
  account: string,
  root: string = defaultFixturesRoot(),
): Promise<FakeFixture | null> {
  if (!isFakeAccountKey(account)) return null
  let text: string
  try {
    text = await readFile(path.join(root, provider, `${account}.json`), "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
  const parsed = fakeFixtureSchema.safeParse(JSON.parse(text))
  if (!parsed.success) {
    throw new Error(
      `Malformed social fixture ${provider}/${account}.json: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    )
  }
  return parsed.data
}

/** Fixture accounts of a provider, sorted by key (the first is the default). */
export async function listFakeAccounts(
  provider: SocialProviderId,
  root: string = defaultFixturesRoot(),
): Promise<FakeAccountSummary[]> {
  let files: string[]
  try {
    files = await readdir(path.join(root, provider))
  } catch {
    return []
  }
  const keys = files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .filter(isFakeAccountKey)
    .sort()
  const accounts: FakeAccountSummary[] = []
  for (const key of keys) {
    const fixture = await loadFakeFixture(provider, key, root)
    if (fixture) accounts.push({ key, label: fixture.label, description: fixture.description })
  }
  return accounts
}
