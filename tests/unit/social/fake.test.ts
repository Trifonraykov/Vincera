import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetEnvCache } from "@/lib/env"
import {
  defaultFixturesRoot,
  fakeFixtureSchema,
  listFakeAccounts,
  loadFakeFixture,
} from "@/lib/social/fake/fixtures"
import { isFakeValueExpired, mintFakeValue, readFakeValue } from "@/lib/social/fake/signing"
import { createFakeSocialFetch } from "@/lib/social/fake/transport"
import { getProvider, isProviderFakeSafe } from "@/lib/social/registry"
import { SOCIAL_PROVIDER_IDS, type SocialProviderId } from "@/lib/social/types"

import { NOW, resetSocialTest, setupSocialTest } from "./helpers"

beforeEach(() => setupSocialTest())
afterEach(() => resetSocialTest())

const API_HOSTS: Record<SocialProviderId, string[]> = {
  youtube: ["www.googleapis.com", "youtubeanalytics.googleapis.com"],
  instagram: ["graph.instagram.com"],
  tiktok: ["open.tiktokapis.com"],
  github: ["api.github.com"],
}

describe("social fixtures", () => {
  it("has 2–3 valid fixture accounts per provider, recording only that provider's API", async () => {
    for (const provider of SOCIAL_PROVIDER_IDS) {
      const dir = path.join(defaultFixturesRoot(), provider)
      const files = (await readdir(dir)).filter((file) => file.endsWith(".json"))
      expect(files.length, provider).toBeGreaterThanOrEqual(2)
      expect(files.length, provider).toBeLessThanOrEqual(3)

      for (const file of files) {
        const fixture = fakeFixtureSchema.parse(
          JSON.parse(await readFile(path.join(dir, file), "utf8")),
        )
        for (const response of fixture.responses) {
          expect(API_HOSTS[provider], `${provider}/${file}`).toContain(new URL(response.url).host)
        }
        expect(provider === "instagram" ? fixture.oauth.longLived : true).toBeTruthy()
        // Recorded replies never carry real-looking tokens: only placeholders.
        expect(JSON.stringify(fixture.oauth)).not.toMatch(/"(access|refresh)_token":"(?!\{\{)/)
      }
    }
  })

  it("lists accounts sorted by key, and refuses unsafe or unknown keys", async () => {
    const accounts = await listFakeAccounts("youtube")
    expect(accounts.map((account) => account.key)).toEqual([
      "ada-codes",
      "lapsed-lens",
      "quiet-kitchen",
    ])
    expect(accounts[0]!.label).toContain("Ada Codes")
    expect(await loadFakeFixture("youtube", "../github/octo-builder")).toBeNull()
    expect(await loadFakeFixture("youtube", "nobody")).toBeNull()
    expect(await listFakeAccounts("youtube", "/nonexistent-root")).toEqual([])
  })
})

describe("fake signed values", () => {
  const fields = {
    provider: "youtube" as const,
    account: "ada-codes",
    issuedAt: NOW,
    ttlSeconds: 60,
  }

  it("round-trips and expires on the app clock", () => {
    const value = mintFakeValue("access", fields)
    const read = readFakeValue(value, "access")
    expect(read).toMatchObject({
      k: "access",
      p: "youtube",
      a: "ada-codes",
      exp: NOW.getTime() + 60_000,
    })
    expect(isFakeValueExpired(read!, NOW)).toBe(false)
    expect(isFakeValueExpired(read!, new Date(NOW.getTime() + 60_000))).toBe(true)
    expect(
      readFakeValue(mintFakeValue("refresh", { ...fields, ttlSeconds: null }), "refresh")?.exp,
    ).toBeNull()
  })

  it("rejects tampering, the wrong kind, and values signed under another secret", () => {
    const value = mintFakeValue("code", fields)
    expect(readFakeValue(value, "access")).toBeNull()
    expect(readFakeValue(`${value}x`, "code")).toBeNull()
    expect(readFakeValue(value.replace(".", "x."), "code")).toBeNull()
    expect(readFakeValue(undefined, "code")).toBeNull()

    vi.stubEnv("AUTH_SECRET", "another-auth-secret-0123456789abcdefghijkl")
    resetEnvCache()
    expect(readFakeValue(value, "code")).toBeNull()
  })
})

describe("fake transport", () => {
  it("answers API calls without a valid token with the provider's 401 shape", async () => {
    const fetch = createFakeSocialFetch("github")
    const response = await fetch("https://api.github.com/user", {
      method: "GET",
      headers: { Authorization: "Bearer gho_real_looking" },
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ message: "Bad credentials" })
  })

  it("answers unrecorded requests with the provider's 404 and logs no query string", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const token = mintFakeValue("access", {
      provider: "youtube",
      account: "ada-codes",
      issuedAt: NOW,
      ttlSeconds: 3600,
    })
    const fetch = createFakeSocialFetch("youtube")
    const response = await fetch(
      "https://www.googleapis.com/youtube/v3/search?part=snippet&q=secret-query",
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    )
    expect(response.status).toBe(404)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).not.toContain("secret-query")
    expect(String(warn.mock.calls[0]![0])).not.toContain(token)
  })

  it("refuses token requests without client credentials", async () => {
    const fetch = createFakeSocialFetch("tiktok")
    const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=x",
    })
    expect(await response.json()).toMatchObject({ error: "invalid_client" })
  })
})

describe("provider registry", () => {
  it("uses the fake provider when credentials are missing", () => {
    const url = new URL(getProvider("youtube").authUrl("s"))
    expect(url.origin).toBe("http://localhost:3000")
    expect(url.pathname).toBe("/api/dev/fake-oauth/youtube/authorize")
    expect(url.searchParams.get("client_id")).toBe("fake-youtube-client")
    expect(isProviderFakeSafe("youtube")).toBe(true)
  })

  it("decides per provider: live where credentials exist, fake elsewhere", () => {
    setupSocialTest({ GOOGLE_YT_CLIENT_ID: "yt-id", GOOGLE_YT_CLIENT_SECRET: "yt-secret" })
    const youtube = new URL(getProvider("youtube").authUrl("s"))
    expect(youtube.origin).toBe("https://accounts.google.com")
    expect(youtube.searchParams.get("client_id")).toBe("yt-id")
    expect(isProviderFakeSafe("youtube")).toBe(false)
    expect(new URL(getProvider("github").authUrl("s")).pathname).toBe(
      "/api/dev/fake-oauth/github/authorize",
    )
  })

  it("forces fakes with FAKE_SERVICES=social even when credentials exist", () => {
    setupSocialTest({
      GITHUB_DATA_CLIENT_ID: "gh-id",
      GITHUB_DATA_CLIENT_SECRET: "gh-secret",
      FAKE_SERVICES: "social",
    })
    expect(new URL(getProvider("github").authUrl("s")).pathname).toBe(
      "/api/dev/fake-oauth/github/authorize",
    )
  })

  it("never reports a fake as usable in production", () => {
    setupSocialTest({ APP_ENV: "production" })
    expect(isProviderFakeSafe("youtube")).toBe(false)
  })
})
