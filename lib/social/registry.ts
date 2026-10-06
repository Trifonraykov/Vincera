import "server-only"

import { env, isSocialProviderFake } from "@/lib/env"
import { absoluteUrl } from "@/lib/urls"

import { createFakeSocialFetch } from "./fake/transport"
import { createGitHubProvider } from "./github"
import { liveSocialFetch, type ProviderConfig, type SocialFetch } from "./http"
import { createInstagramProvider } from "./instagram"
import { createTikTokProvider } from "./tiktok"
import type { SocialProvider, SocialProviderId } from "./types"
import { createYouTubeProvider } from "./youtube"

/**
 * The one way to get a social provider (§7.1, CLAUDE.md §19.13). Live when the provider's
 * credentials are configured, fake otherwise (`isSocialProviderFake`). The fake is the same
 * provider code with two differences: the authorization URL points at the dev page
 * `/api/dev/fake-oauth/<provider>/authorize`, and HTTP goes to the fixture transport instead of
 * the network. So Zod parsing and mapping run for real in dev, e2e and tests.
 */

const FACTORIES = {
  youtube: createYouTubeProvider,
  instagram: createInstagramProvider,
  tiktok: createTikTokProvider,
  github: createGitHubProvider,
} as const satisfies Record<SocialProviderId, (config: ProviderConfig) => SocialProvider>

/** Our OAuth callback path for a provider; register `absoluteUrl()` of it with the provider. */
export function oauthCallbackPath(provider: SocialProviderId): string {
  return `/api/oauth/${provider}/callback`
}

/** The fake authorize page (dev/test only; 404 unless the provider is fake). */
export function fakeAuthorizePath(provider: SocialProviderId): string {
  return `/api/dev/fake-oauth/${provider}/authorize`
}

/** Client id the fake providers expect (any non-empty value works). */
export function fakeClientId(provider: SocialProviderId): string {
  return `fake-${provider}-client`
}

function credentials(provider: SocialProviderId): { clientId?: string; clientSecret?: string } {
  switch (provider) {
    case "youtube":
      return { clientId: env.GOOGLE_YT_CLIENT_ID, clientSecret: env.GOOGLE_YT_CLIENT_SECRET }
    case "instagram":
      return { clientId: env.META_APP_ID, clientSecret: env.META_APP_SECRET }
    case "tiktok":
      return { clientId: env.TIKTOK_CLIENT_KEY, clientSecret: env.TIKTOK_CLIENT_SECRET }
    case "github":
      return { clientId: env.GITHUB_DATA_CLIENT_ID, clientSecret: env.GITHUB_DATA_CLIENT_SECRET }
  }
}

export type GetProviderOptions = {
  /** Replace the transport (tests). */
  fetch?: SocialFetch
  now?: () => Date
}

export function getProvider(
  provider: SocialProviderId,
  options: GetProviderOptions = {},
): SocialProvider {
  const redirectUri = absoluteUrl(oauthCallbackPath(provider))
  const shared = { redirectUri, now: options.now, userAgent: env.APP_NAME }

  if (isSocialProviderFake(provider)) {
    return FACTORIES[provider]({
      ...shared,
      clientId: fakeClientId(provider),
      clientSecret: "fake-client-secret",
      authorizeUrl: absoluteUrl(fakeAuthorizePath(provider)),
      fetch: options.fetch ?? createFakeSocialFetch(provider),
    })
  }

  const { clientId, clientSecret } = credentials(provider)
  if (!clientId || !clientSecret) {
    // isSocialProviderFake() is false only when both are set; this guards against drift.
    throw new Error(`${provider} credentials are not configured`)
  }
  return FACTORIES[provider]({
    ...shared,
    clientId,
    clientSecret,
    fetch: options.fetch ?? liveSocialFetch,
  })
}

/** Whether `provider` runs fake, without throwing in production (for routes that must 404). */
export function isProviderFakeSafe(provider: SocialProviderId): boolean {
  try {
    return isSocialProviderFake(provider)
  } catch {
    // isSocialProviderFake throws when a fake would run in production: treat as "not fake".
    return false
  }
}
