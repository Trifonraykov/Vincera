import { setClockForTests } from "@/lib/clock"
import { createFakeSocialFetch, mintFakeAuthorizationCode } from "@/lib/social/fake/transport"
import { createGitHubProvider } from "@/lib/social/github"
import type { ProviderConfig, SocialFetch, SocialRequestInit } from "@/lib/social/http"
import { createInstagramProvider } from "@/lib/social/instagram"
import { createCodeVerifier, pkceChallenge } from "@/lib/social/pkce"
import { getProvider } from "@/lib/social/registry"
import { createTikTokProvider } from "@/lib/social/tiktok"
import type { SocialProvider, SocialProviderId, TokenSet } from "@/lib/social/types"
import { createYouTubeProvider } from "@/lib/social/youtube"

import { stubServiceEnv, TEST_APP_URL } from "../../helpers/service-env"

/**
 * Shared setup for the social provider tests: the real provider code from the registry, fed by
 * the fake fixture transport (tests/fixtures/social), with every request recorded.
 */

export const NOW = new Date("2026-10-05T12:00:00.000Z")

const SOCIAL_CREDENTIALS = [
  "GOOGLE_YT_CLIENT_ID",
  "GOOGLE_YT_CLIENT_SECRET",
  "META_APP_ID",
  "META_APP_SECRET",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "GITHUB_DATA_CLIENT_ID",
  "GITHUB_DATA_CLIENT_SECRET",
] as const

/** A valid test environment where every social provider is fake unless `overrides` say not. */
export function stubSocialEnv(overrides: Record<string, string> = {}): void {
  const blank = Object.fromEntries(SOCIAL_CREDENTIALS.map((key) => [key, ""]))
  stubServiceEnv({ ...blank, ...overrides })
}

/** Standard per-test setup: fake env and a fixed clock. Call `resetSocialTest()` after. */
export function setupSocialTest(overrides: Record<string, string> = {}): void {
  stubSocialEnv(overrides)
  setClockForTests(NOW)
}

export function resetSocialTest(): void {
  setClockForTests(null)
}

export function setClock(at: Date): void {
  setClockForTests(at)
}

export const callbackUrl = (provider: SocialProviderId) =>
  `${TEST_APP_URL}/api/oauth/${provider}/callback`

export type RecordedCall = { method: string; url: URL; init: SocialRequestInit }

/** Return a Response to replace the fake's answer for this request, or undefined to pass. */
export type Override = (
  url: URL,
  init: SocialRequestInit,
) => Response | undefined | Promise<Response | undefined>

export type TestProvider = {
  provider: SocialProvider
  calls: RecordedCall[]
  /** Calls whose URL path ends with `suffix` (e.g. `/videos`). */
  callsTo: (suffix: string) => RecordedCall[]
}

/** The registry's (fake) provider with a recording transport and optional overrides. */
export function fakeProvider(id: SocialProviderId, override?: Override): TestProvider {
  const base = createFakeSocialFetch(id)
  const calls: RecordedCall[] = []
  const fetch: SocialFetch = async (url, init) => {
    const parsed = new URL(url)
    calls.push({ method: init.method, url: parsed, init })
    return (await override?.(parsed, init)) ?? base(url, init)
  }
  return {
    provider: getProvider(id, { fetch }),
    calls,
    callsTo: (suffix) => calls.filter((call) => call.url.pathname.endsWith(suffix)),
  }
}

const FACTORIES = {
  youtube: createYouTubeProvider,
  instagram: createInstagramProvider,
  tiktok: createTikTokProvider,
  github: createGitHubProvider,
} as const

/** A provider built like the live one (real endpoints, no fake authorize page). */
export function liveLikeProvider(
  id: SocialProviderId,
  fetch: SocialFetch = async () => {
    throw new Error("no network in unit tests")
  },
  extra: Partial<ProviderConfig> = {},
): SocialProvider {
  return FACTORIES[id]({
    clientId: `live-${id}-client`,
    clientSecret: `live-${id}-secret`,
    redirectUri: callbackUrl(id),
    fetch,
    ...extra,
  })
}

/** Run the authorization-code flow against the fake for a fixture account. */
export async function connect(
  provider: SocialProvider,
  account: string,
  options: { verifier?: string | null } = {},
): Promise<TokenSet> {
  const verifier =
    options.verifier === undefined
      ? provider.supportsPkce
        ? createCodeVerifier()
        : null
      : options.verifier
  const code = mintFakeAuthorizationCode({
    provider: provider.id,
    account,
    redirectUri: callbackUrl(provider.id),
    codeChallenge: verifier ? pkceChallenge(verifier).codeChallenge : undefined,
  })
  return provider.exchangeCode(code, verifier ? { codeVerifier: verifier } : undefined)
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

/** The error a promise rejects with (fails the test when it resolves). */
export async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`rejected with a non-Error: ${String(error)}`)
  }
  throw new Error("expected the promise to reject")
}
