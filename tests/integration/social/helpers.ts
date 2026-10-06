import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import { expect } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import type { Db } from "@/lib/db/client"
import { events, users } from "@/lib/db/schema"
import { mintFakeAuthorizationCode } from "@/lib/social/fake/transport"
import { oauthCallbackResponse, oauthStartResponse } from "@/lib/social/oauth-flow"
import type { SocialProviderId } from "@/lib/social/types"

import { insertCreator } from "../../helpers/db-fixtures"
import { TEST_APP_URL } from "../../helpers/service-env"

/**
 * Shared setup for the connection-flow integration tests: the real OAuth route logic
 * (lib/social/oauth-flow.ts) against the fake providers, a test database and a temporary `.data`
 * directory (fake email outbox and storage).
 */

export async function makeTempDataDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "social-flow-test-"))
}

export async function removeTempDataDir(dir: string): Promise<void> {
  if (dir) await rm(dir, { recursive: true, force: true })
}

export function authUserOf(
  row: typeof users.$inferSelect,
  overrides: Partial<AuthUser> = {},
): AuthUser {
  return {
    id: row.id,
    email: row.email ?? "unknown@example.test",
    name: row.name,
    image: null,
    roles: row.roles,
    activeRole: row.activeRole,
    status: row.status,
    onboardingCompletedAt: row.onboardingCompletedAt,
    ...overrides,
  }
}

/** A creator user (with profile) as the session would see it. */
export async function newCreator(db: Db) {
  const creator = await insertCreator(db)
  return { ...creator, auth: authUserOf(creator.user) }
}

export function cookieFrom(response: Response): string {
  const header = response.headers.getSetCookie()[0]
  if (!header) throw new Error("no Set-Cookie on the response")
  return header.split(";")[0] ?? ""
}

export type OAuthRun = {
  start: Response
  authorizeUrl: URL
  callback: Response
  /** Where the callback redirected, as an app path with query. */
  landing: string
  enqueued: string[]
}

/**
 * Run start → (fake consent for `account`) → callback, like a browser would. `callbackUser`
 * simulates someone else finishing the flow; `mutate` tampers with the callback URL.
 */
export async function runOAuthFlow(
  db: Db,
  input: {
    user: AuthUser
    provider: SocialProviderId
    account: string
    returnTo?: string
    callbackUser?: AuthUser
    mutate?: (url: URL) => void
    dropCookie?: boolean
  },
): Promise<OAuthRun> {
  const returnTo = input.returnTo ?? "/onboarding/creator/connect"
  const startUrl = `${TEST_APP_URL}/api/oauth/${input.provider}/start?returnTo=${encodeURIComponent(returnTo)}`
  const start = await oauthStartResponse(new NextRequest(startUrl), input.provider, {
    user: input.user,
    db,
  })
  expect(start.status).toBe(303)
  const authorizeUrl = new URL(start.headers.get("location") ?? "")
  const cookie = cookieFrom(start)

  const state = authorizeUrl.searchParams.get("state") ?? ""
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri") ?? ""
  const code = mintFakeAuthorizationCode({
    provider: input.provider,
    account: input.account,
    redirectUri,
    codeChallenge: authorizeUrl.searchParams.get("code_challenge") ?? undefined,
  })
  const callbackUrl = new URL(redirectUri)
  callbackUrl.searchParams.set("code", code)
  callbackUrl.searchParams.set("state", state)
  input.mutate?.(callbackUrl)

  const enqueued: string[] = []
  const callback = await oauthCallbackResponse(
    new NextRequest(callbackUrl, { headers: input.dropCookie ? {} : { cookie } }),
    input.provider,
    {
      user: input.callbackUser ?? input.user,
      db,
      enqueueSync: async (connectionId) => {
        enqueued.push(connectionId)
      },
    },
  )
  const location = new URL(callback.headers.get("location") ?? "", TEST_APP_URL)
  return {
    start,
    authorizeUrl,
    callback,
    landing: `${location.pathname}${location.search}`,
    enqueued,
  }
}

export async function eventsOf(db: Db, type: string, subjectId?: string) {
  return db
    .select()
    .from(events)
    .where(
      subjectId
        ? and(eq(events.type, type), eq(events.subjectId, subjectId))
        : eq(events.type, type),
    )
}
