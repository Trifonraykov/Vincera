# Stripe — implementation brief (researched 2026-10-05)

Sources:

- docs.stripe.com, via search excerpts with URLs.
- stripe-node 23.0.0 type definitions. These are generated from OpenAPI, so param names and enums are exact.

Items marked **UNCONFIRMED** must be verified in a Stripe sandbox. Decisions taken are recorded in CLAUDE.md §19.

## SDK / API version

- `stripe@23` pins API version **`2026-09-30.endive`** and needs Node ≥20. Create the client with `new Stripe(key)`; pass options as the 2nd argument, e.g. `{ idempotencyKey }`.
- endive removed `payment_method_types` from Checkout/PaymentIntent create. Use the Dashboard payment-method settings, or `allowed_payment_method_types` / `excluded_payment_method_types`.
- `ui_mode` values are now `hosted_page | embedded_page | elements | form`.
- Static `Stripe.webhooks.*` (`constructEvent`, `generateTestHeaderString`) works without an API key.

## Connect onboarding

- **`type: 'express'` is deprecated** for new integrations.
  - Stripe recommends **Accounts v2**: `dashboard: 'express'` plus the `recipient` configuration.
  - The supported v1 equivalent is **controller properties**.
- **v1 controller properties** (what we use; see §19):
  ```ts
  stripe.accounts.create({
    country,
    email,
    business_type: "individual",
    controller: {
      fees: { payer: "application" },
      losses: { payments: "application" },
      requirement_collection: "stripe",
      stripe_dashboard: { type: "express" },
    },
    capabilities: { transfers: { requested: true } }, // card_payments not needed: the platform is the merchant
  })
  ```
  - With `stripe_dashboard.type = 'express'`, `fees.payer = 'application'`, `losses.payments = 'application'` and `requirement_collection = 'stripe'` are mandatory.
- **Account Links:** `stripe.accountLinks.create({ account, type: 'account_onboarding', refresh_url, return_url })`.
  - Links are single-use.
  - Reaching `return_url` does not mean onboarding is complete; re-fetch the account.
- **Express Dashboard:** `stripe.accounts.createLoginLink(acctId)`.
- **`account.updated` is a Connect event.** It goes only to an endpoint created with `connect: true`, which has its **own signing secret**.
  - That means a separate secret, `STRIPE_CONNECT_WEBHOOK_SECRET`.
  - Local forwarding: `stripe listen --forward-connect-to localhost:3000/api/webhooks/stripe`.
  - `capability.updated` also comes on the Connect endpoint.
- **Readiness for receiving transfers:** gate on `capabilities.transfers === 'active'` plus `payouts_enabled`. `charges_enabled` is irrelevant for transfer-only accounts.
- **Accounts v2** (alternative):
  - Create: `stripe.v2.core.accounts.create({ dashboard: 'express', identity: { country, entity_type }, defaults: { currency: 'eur', responsibilities: { fees_collector: 'application', losses_collector: 'application' } }, configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } } })`.
  - Onboarding: `stripe.v2.core.accountLinks.create({ account, use_case: { type: 'account_onboarding', account_onboarding: { refresh_url, return_url } } })`.
  - Status arrives as thin events, e.g. `v2.core.account[configuration.recipient].capability_status_updated`. Parse them with `stripe.parseEventNotification`; `constructEvent` throws on thin payloads.
  - v2 accounts have no `charges_enabled`, `payouts_enabled` or `details_submitted`.
- **Cross-border:** platforms in the US, UK, EEA, CA or CH can transfer to connected accounts in any of those regions under the **full** service agreement. Do **not** use the `recipient` service agreement: it blocks cross-border payouts.

## Checkout Session (one-off digital product + Stripe Tax)

```ts
stripe.checkout.sessions.create(
  {
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: priceCents,
          tax_behavior: "inclusive",
          product_data: { name, tax_code, metadata: { launch_id } },
        },
      },
    ],
    automatic_tax: { enabled: true },
    billing_address_collection: "auto",
    tax_id_collection: { enabled: true },
    customer_creation: "if_required",
    client_reference_id: orderRef,
    metadata: { order_ref, launch_id, tracked_link_id }, // strings only; omit null keys
    payment_intent_data: {
      metadata: { order_ref, launch_id, tracked_link_id },
      transfer_group: `order_${orderRef}`,
    },
    allow_promotion_codes: true, // or discounts: [{ promotion_code }] — not both (UNCONFIRMED)
    success_url: `${APP_URL}/p/${slug}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/p/${slug}`,
    expires_at: nowSec + 1800,
  },
  { idempotencyKey },
)
```

- Session `metadata` is **not** copied to the PaymentIntent, so set `payment_intent_data.metadata` as well.
- **Tax codes:**
  - Downloadable software: `txcd_10202000` (personal use) / `txcd_10202003` (business use).
  - SaaS (`delivery_type=url` apps): `txcd_10103000` / `txcd_10103001`.
  - Generic ESS: `txcd_10000000` (EU only; Stripe says not to use it for US sales).
  - Map a code per `delivery_type`.
- **Stripe Tax prerequisites:**
  - Activate Tax and set the head-office (origin) address.
  - Add registrations. Spain: `standard` with `place_of_supply_scheme: 'small_seller'` while EU cross-border B2C sales stay under €10k/yr; after that, `oss_union`.
  - Without a registration, the tax computed is **0**.
  - Stripe Tax does not file returns.
- **Stripe Managed Payments** (merchant of record) does **not** support Connect. This is relevant to open decision §18.1.

## Fee and tax after payment

- Tax: `session.total_details.amount_tax`.
- Fee: retrieve the PaymentIntent with `expand: ['latest_charge.balance_transaction']`, then read `bt.fee`, `bt.fee_details[]`, `bt.net` and `bt.available_on`.
- **Async capture is the default.** `balance_transaction` can be **null** at `checkout.session.completed`; it arrives with `charge.updated`, within about 1h.
  - So ledger posting must handle a "fee pending" state.
  - It is triggered both by `checkout.session.completed` (when the fee is known) and by `charge.updated`, and is idempotent.
- **Only fulfil when `session.payment_status === 'paid'`.** For delayed payment methods, fulfil on `checkout.session.async_payment_succeeded` and handle `checkout.session.async_payment_failed`.

## Transfers

- Create with `stripe.transfers.create({ amount, currency, destination, transfer_group, metadata }, { idempotencyKey })`.
- **`source_transaction` ties a transfer to exactly ONE charge.** It only helps while that charge is unsettled; after a 14-day hold it adds nothing.
  - Decision: **one aggregated transfer per user per batch, without `source_transaction`.**
  - Idempotency key: `payout:${batchId}:${userId}`. Keys expire after 24h, so also reconcile via the `transfer_group` / metadata.
- **Insufficient balance:** a transfer fails with `balance_insufficient` when the platform's available balance is too low. Stripe does not auto-retry.
  - **Set the platform's own payout schedule to manual**, or keep a minimum balance. Otherwise the platform's automatic payouts drain the held funds.
- **Reversals:** `stripe.transfers.createReversal(trId, { amount, metadata })`. Partial reversals are allowed.
  - A reversal **fails if the connected account's available balance is lower than the amount**, which is likely after its daily payouts.
  - Fallback: keep the negative ledger entries and net them against future payouts.
- Events: `transfer.created` and `transfer.reversed` still exist.

## Refunds, disputes, webhooks

- **Refunds:**
  - `refund.created`, `refund.updated` and `refund.failed` fire for all refunds. Prefer them over `charge.refunded` (which still exists).
  - **Stripe fees are not returned on refunds.**
  - Stripe Tax records the tax reversal automatically for Checkout payments.
- **Disputes:** under separate charges and transfers, the platform is debited the disputed amount plus the dispute fee. Events: `charge.dispute.created`, `.updated`, `.closed`, `.funds_withdrawn`, `.funds_reinstated`.
- **Endpoint subscriptions:**
  - Account endpoint: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.updated`, `refund.created`, `refund.updated`, `refund.failed`, `charge.dispute.created`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`, `transfer.created`, `transfer.reversed`.
  - Connect endpoint: `account.updated`, `capability.updated`, `payout.failed`.
- **Next.js route handler:**
  - Read the raw body with `await req.text()`, then call `stripe.webhooks.constructEvent(body, sig, secret)` (default tolerance 300s).
  - Tests: `stripe.webhooks.generateTestHeaderString({ payload, secret })`.
  - Pin each endpoint's API version to `2026-09-30.endive`.
