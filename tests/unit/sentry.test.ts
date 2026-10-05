import { describe, expect, it, vi } from "vitest"

import { scrubEvent, sharedSentryOptions, withoutQuery } from "@/sentry.shared"

const captureRequestError = vi.hoisted(() => vi.fn())
vi.mock("@sentry/nextjs", () => ({ captureRequestError }))

const { onRequestError } = await import("@/instrumentation")

/**
 * URLs can carry magic-link tokens, signed storage URLs and OAuth codes; none of that may reach
 * Sentry (§11, §14, §19.7).
 */

describe("withoutQuery", () => {
  it.each([
    ["/api/auth/callback/email?token=abc&email=a%40b.c", "/api/auth/callback/email"],
    ["/api/dev/storage/k?op=get&exp=1&sig=x#frag", "/api/dev/storage/k"],
    ["/app/ideas#top", "/app/ideas"],
    ["/app", "/app"],
    ["?only=query", ""],
  ])("%s → %s", (input, expected) => {
    expect(withoutQuery(input)).toBe(expected)
  })
})

describe("onRequestError", () => {
  it("reports the request path without its query string", () => {
    const error = new Error("boom")
    const context = {
      routerKind: "App Router",
      routePath: "/api/auth/[...nextauth]",
      routeType: "route",
      renderSource: undefined,
      revalidateReason: undefined,
      renderType: undefined,
    } as const
    const request = {
      path: "/api/auth/callback/email?token=secret-token&email=ada%40example.com",
      method: "GET",
      headers: {},
    }

    void onRequestError(error, request, context)

    expect(captureRequestError).toHaveBeenCalledWith(
      error,
      { ...request, path: "/api/auth/callback/email" },
      context,
    )
  })
})

describe("scrubEvent (beforeSend)", () => {
  it("is installed for every SDK", () => {
    expect(sharedSentryOptions.beforeSend).toBe(scrubEvent)
    expect(sharedSentryOptions.dataCollection.urlQueryParams).toBe(false)
  })

  it("drops the query string from the Next.js request context", () => {
    const event = {
      contexts: {
        nextjs: { request_path: "/access/tok?sig=abc", route_type: "render" },
        app: { app_name: "x" },
      },
    }
    expect(scrubEvent(event).contexts).toEqual({
      nextjs: { request_path: "/access/tok", route_type: "render" },
      app: { app_name: "x" },
    })
  })

  it("leaves events without that context alone", () => {
    expect(scrubEvent({})).toEqual({})
    expect(scrubEvent({ contexts: { nextjs: { router_kind: "App Router" } } })).toEqual({
      contexts: { nextjs: { router_kind: "App Router" } },
    })
  })
})
