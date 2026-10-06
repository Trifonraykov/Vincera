import Stripe from "stripe"
import { describe, expect, it } from "vitest"

import { STRIPE_API_VERSION } from "@/lib/stripe/client"
import { StripeGatewayError } from "@/lib/stripe/gateway"
import { createLiveStripeGateway } from "@/lib/stripe/live"

import accountUpdated from "../../fixtures/stripe/account.updated.json"

/**
 * The live gateway against a stubbed HTTP layer: checks the requests the SDK sends (parameters,
 * idempotency key, pinned API version) and that responses are parsed, without network access.
 */

type Captured = { url: string; method: string; headers: Headers; body: string }

function stubbedStripe(respond: (request: Captured) => { status: number; body: unknown }) {
  const calls: Captured[] = []
  const fetchStub: typeof fetch = async (input, init) => {
    const request: Captured = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit),
      body: typeof init?.body === "string" ? init.body : "",
    }
    calls.push(request)
    const { status, body } = respond(request)
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "request-id": "req_test" },
    })
  }
  const stripe = new Stripe("sk_test_unit", {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(fetchStub),
    maxNetworkRetries: 0,
  })
  return { gateway: createLiveStripeGateway(stripe), calls }
}

const account = accountUpdated.data.object

describe("live Stripe gateway", () => {
  it("creates v1 accounts with controller properties and the idempotency key", async () => {
    const { gateway, calls } = stubbedStripe(() => ({ status: 200, body: account }))
    const created = await gateway.createConnectedAccount(
      { country: "ES", email: "maker@example.test", userId: "user-1" },
      { idempotencyKey: "acct:user-1" },
    )
    expect(created.id).toBe(account.id)

    const [call] = calls
    if (!call) throw new Error("no request")
    expect(call.method).toBe("POST")
    expect(call.url).toBe("https://api.stripe.com/v1/accounts")
    expect(call.headers.get("idempotency-key")).toBe("acct:user-1")
    expect(call.headers.get("stripe-version")).toBe(STRIPE_API_VERSION)
    const params = new URLSearchParams(call.body)
    expect(Object.fromEntries(params)).toEqual({
      country: "ES",
      email: "maker@example.test",
      "controller[fees][payer]": "application",
      "controller[losses][payments]": "application",
      "controller[requirement_collection]": "stripe",
      "controller[stripe_dashboard][type]": "express",
      "capabilities[transfers][requested]": "true",
      "tos_acceptance[service_agreement]": "full",
      "metadata[user_id]": "user-1",
    })
  })

  it("omits the email when the user has none", async () => {
    const { gateway, calls } = stubbedStripe(() => ({ status: 200, body: account }))
    await gateway.createConnectedAccount(
      { country: "US", email: null, userId: "user-2" },
      { idempotencyKey: "acct:user-2" },
    )
    expect(new URLSearchParams(calls[0]?.body).has("email")).toBe(false)
  })

  it("creates onboarding links and login links", async () => {
    const { gateway, calls } = stubbedStripe((request) =>
      request.url.endsWith("/account_links")
        ? {
            status: 200,
            body: {
              object: "account_link",
              created: 1791201600,
              expires_at: 1791201900,
              url: "https://connect.stripe.com/setup/e/acct_1QfixtureConnected/abc",
            },
          }
        : {
            status: 200,
            body: {
              object: "login_link",
              created: 1791201600,
              url: "https://connect.stripe.com/express/abc",
            },
          },
    )
    const link = await gateway.createAccountLink({
      accountId: account.id,
      refreshUrl: "https://app.example.test/onboarding/payouts/refresh",
      returnUrl: "https://app.example.test/onboarding/payouts?return=1",
    })
    expect(link.url).toContain("connect.stripe.com")
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({
      account: account.id,
      type: "account_onboarding",
      refresh_url: "https://app.example.test/onboarding/payouts/refresh",
      return_url: "https://app.example.test/onboarding/payouts?return=1",
    })

    const login = await gateway.createLoginLink(account.id)
    expect(login.url).toBe("https://connect.stripe.com/express/abc")
    expect(calls[1]?.url).toBe(`https://api.stripe.com/v1/accounts/${account.id}/login_links`)
  })

  it("parses retrieved accounts and maps resource_missing", async () => {
    const { gateway } = stubbedStripe((request) =>
      request.url.endsWith(account.id)
        ? { status: 200, body: account }
        : {
            status: 404,
            body: {
              error: {
                type: "invalid_request_error",
                code: "resource_missing",
                message: "No such account",
              },
            },
          },
    )
    expect(await gateway.retrieveAccount(account.id)).toMatchObject({
      id: account.id,
      payouts_enabled: true,
      capabilities: { transfers: "active" },
    })
    const error = await gateway.retrieveAccount("acct_missing").catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(StripeGatewayError)
  })

  it("rejects responses that do not look like an account (§4: parse every response)", async () => {
    const { gateway } = stubbedStripe(() => ({
      status: 200,
      body: { id: "cus_1", object: "customer" },
    }))
    await expect(gateway.retrieveAccount(account.id)).rejects.toThrow()
  })
})
