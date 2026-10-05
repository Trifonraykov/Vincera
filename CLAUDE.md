# CLAUDE.md — Creator × Builder Platform: Build Instructions

> Put this file in the repo root as `CLAUDE.md`. Claude Code reads it at the start of every session.
> Companion doc: **Page Map — Creator × Developer Platform**, which describes every page. Routes in §12 match it exactly.

---

## 0. How to work on this repo

- Build **phase by phase** (§16). Do not start a phase until the previous phase's acceptance criteria pass.
- At the end of each phase: run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`, then summarise what was built, what's stubbed, and any deviations from this file.
- If a requirement here is ambiguous or conflicts with reality (an API scope no longer exists, a library changed), **stop and ask**. Do not invent behaviour.
- Use the latest stable versions of all libraries. Check docs before using any API you are unsure of. Never hard-code version numbers from memory into instructions or comments.
- Money is **integer minor units (cents)** everywhere. Never floats.
- All timestamps are stored in UTC (`timestamptz`).
- Every state change that matters to the business writes an **event** (§11). This is non-negotiable: the event log is the product's long-term asset.
- Keep this file updated. When a decision changes, edit the relevant section in the same PR.

---

## 1. Product summary

A two-sided platform where **creators** (people with audiences on YouTube, Instagram, TikTok) and **builders** (developers and technical makers) meet to co-create and sell small paid digital products. Examples: tools, templates, mini-apps, AI utilities.

**Core loop (MVP):**

1. **Match.** Creators connect socials and post *ideas* (what their audience wants). Builders list *products* (things that need distribution). The platform ranks matches.
2. **Propose.** Either side sends a proposal: scope, split %, timeline. The other side can accept, decline, or counter.
3. **Agree.** Both click-sign a standard agreement filled with the deal's terms. Both must have Stripe Connect payouts set up first.
4. **Build.** A shared workspace provides tasks, messages, and files.
5. **Launch.** Both approve a public product page. The creator promotes it with a tracked link.
6. **Sell & split.** Buyers pay via Stripe Checkout. The ledger splits each sale between creator, builder, and platform. Payouts are released after a hold period.

**MVP non-goals:** AI agents acting autonomously, subscriptions or recurring billing, equity deals, brand/company accounts, native mobile apps, a buyer account system, hosting builders' apps.

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js (App Router), TypeScript `strict` | Single app: marketing, app, admin, API routes |
| UI | Tailwind CSS + shadcn/ui, lucide icons | Light/dark, mobile-first |
| DB | PostgreSQL (Neon or Supabase) + `pgvector` | |
| ORM | Drizzle ORM + drizzle-kit migrations | |
| Validation | Zod, shared between client and server | |
| Auth | Auth.js: email magic link, Google, GitHub | Social *data* connections are separate from login (§7) |
| Payments | Stripe Checkout + Stripe Connect (Express) + Stripe Tax | Separate charges and transfers model |
| Jobs / cron | Inngest | Sync, matching, payouts, expiries |
| Email | Resend + React Email | |
| File storage | Cloudflare R2 (S3 API), signed URLs | Product deliverables, attachments, signed agreement PDFs |
| LLM | Claude API (Anthropic SDK) | Summaries, brief drafting, launch copy, match explanations |
| Embeddings | Provider behind an interface (`lib/ai/embed.ts`) | Default: Voyage AI. 1024-dim vectors in pgvector. |
| PDF | `@react-pdf/renderer` | Signed agreements |
| Analytics | PostHog (product analytics), own `events` table (business events) | |
| Errors | Sentry | |
| Tests | Vitest (unit/integration), Playwright (e2e) | Stripe in test mode, mocked social APIs |
| Package manager | pnpm | |
| Hosting | Vercel (app) | Inngest cloud for jobs |

---

## 3. Repo structure

```
/app
  /(marketing)            → /, /creators, /builders, /how-it-works, /pricing, /launches, /legal/*
  /(public-profiles)      → /c/[handle], /b/[handle]
  /(auth)                 → /sign-in, /sign-up
  /onboarding/...         → role, creator/*, builder/*, payouts
  /app/...                → signed-in app (layout with sidebar, role switcher)
  /admin/...              → admin (role-gated layout)
  /p/[slug]/...           → product page, checkout, success
  /r/[code]/route.ts      → tracked-link redirect
  /access/[token]/...     → buyer access
  /api/
    /webhooks/stripe/route.ts
    /oauth/[provider]/callback/route.ts
    /inngest/route.ts
/components               → ui/ (shadcn), shared/, feature folders mirroring routes
/lib
  /db                     → schema/*.ts, client.ts, queries/*
  /auth                   → auth config, session helpers, authz.ts
  /stripe                 → client, checkout.ts, connect.ts, transfers.ts, webhooks.ts
  /ledger                 → split.ts, post.ts, release.ts   (pure functions + tested)
  /social                 → youtube.ts, instagram.ts, tiktok.ts, github.ts, types.ts
  /matching               → features.ts, score.ts, explain.ts
  /ai                     → claude.ts, embed.ts, prompts/*
  /events                 → track.ts, types.ts
  /email                  → templates/*, send.ts
  /storage                → r2.ts
/inngest                  → functions/*
/drizzle                  → migrations
/tests                    → unit/, integration/, e2e/
```

---

## 4. Conventions

- **Server Actions** for mutations from app pages. **Route handlers** only for webhooks, OAuth callbacks, redirects, and checkout.
- Every server action:
  1. parses input with Zod;
  2. calls `requireUser()`;
  3. checks permission via `lib/auth/authz.ts`;
  4. runs in a DB transaction when it touches more than one table;
  5. emits events.
- IDs: UUIDv7 (`uuid` column, generated in app).
- Soft delete only where noted (`deleted_at`). Ledger and events are **append-only**: no updates, no deletes.
- Handles: lowercase, `[a-z0-9_]{3,30}`, unique across creators and builders.
- Secrets and OAuth tokens are encrypted at rest (AES-GCM, key from `ENCRYPTION_KEY`), in `lib/crypto.ts`.
- Errors shown to users are plain language. Log details go to Sentry.
- No `any`. No unchecked casts on external API responses: parse them with Zod.

---

## 5. Data model

Write the schema in Drizzle under `lib/db/schema/`. Below are the tables and their key columns. Add `id`, `created_at`, and `updated_at` to every table unless noted.

### Identity & profiles
- **users**: email, name, avatar_url, `roles` (text[]: `creator` | `builder` | `admin`), `active_role`, `status` (`active` | `suspended`), onboarding_completed_at
- **auth tables**: as required by the Auth.js Drizzle adapter
- **creator_profiles**: user_id (unique), handle, display_name, bio, niche (text), topics (text[]), languages (text[]), country, `size_tier` (`nano` <10k, `micro` 10k–100k, `mid` 100k–500k, `macro` >500k, computed), `audience_summary` (text, AI-generated, user-editable), `embedding` vector(1024), verified_at
- **builder_profiles**: user_id (unique), handle, display_name, bio, skills (text[]), stack (text[]), availability (`open` | `limited` | `closed`), `deal_preference` (`split` | `fixed` | `either`), `embedding` vector(1024), verified_at
- **portfolio_items**: builder_profile_id, title, url, description, image_url, is_shipped

### Social data
- **social_connections**: user_id, provider (`youtube` | `instagram` | `tiktok` | `github`), provider_account_id, username, access_token_enc, refresh_token_enc, expires_at, scopes, status (`active` | `expired` | `revoked`), last_synced_at
- **audience_snapshots** (append-only, no updated_at): social_connection_id, taken_at, followers, avg_views, engagement_rate (numeric(6,4)), top_countries (jsonb), age_gender (jsonb, nullable), top_topics (text[]), raw (jsonb)

### Supply & demand
- **ideas** (creator-posted): creator_profile_id, title, problem (text), audience_evidence (text), format (`app` | `tool` | `template` | `ai_utility` | `course_tool` | `other`), target_price_cents, topics (text[]), status (`draft` | `open` | `in_collab` | `launched` | `archived`), embedding vector(1024)
- **products** (builder-listed): builder_profile_id, title, description, target_user, stage (`idea` | `prototype` | `beta` | `live`), demo_url, format, topics (text[]), preferred_split_builder_pct (int), exclusivity (bool), status (`draft` | `seeking` | `in_collab` | `launched` | `archived`), embedding vector(1024)

### Matching
- **matches**: subject_user_id (who sees it), target_type (`creator` | `builder` | `idea` | `product`), target_id, score (numeric), features (jsonb), explanation (text), model_version (text), status (`shown` | `saved` | `dismissed` | `proposed`), computed_at. Unique on (subject_user_id, target_type, target_id, model_version).
- **saved_items**: user_id, target_type, target_id

### Collaboration
- **proposals**: from_user_id, to_user_id, idea_id (nullable), product_id (nullable; exactly one of idea_id/product_id), status (`pending` | `countered` | `accepted` | `declined` | `expired` | `withdrawn`), current_revision_id, expires_at (default +14 days)
- **proposal_revisions** (append-only): proposal_id, author_user_id, message, scope, creator_split_pct, builder_split_pct (sum = 100), timeline_weeks, created_at
- **collabs**: proposal_id (unique), idea_id, product_id, stage (`agreement` | `building` | `launch_review` | `live` | `ended`), ended_reason
- **collab_members**: collab_id, user_id, role (`creator` | `builder`), split_pct. Unique (collab_id, user_id).
- **agreements**: collab_id, template_version, terms (jsonb snapshot: parties, splits, IP, scope, term, exit), body_hash (sha256 of rendered text), pdf_storage_key (after full signature), status (`awaiting_signatures` | `signed` | `terminated`)
- **agreement_signatures** (append-only): agreement_id, user_id, signed_at, ip, user_agent, typed_name
- **tasks**: collab_id, title, assignee_user_id, due_date, done_at, position
- **threads**: kind (`proposal` | `collab`), proposal_id / collab_id
- **messages**: thread_id, author_user_id, body, attachments (jsonb: storage keys), created_at
- **thread_reads**: thread_id, user_id, last_read_at

### Launch & commerce
- **launches**: collab_id (unique), slug (unique), title, tagline, description_md, price_cents, currency (default `eur`), media (jsonb), delivery_type (`file` | `license_key` | `url`), delivery_config (jsonb), status (`draft` | `pending_approval` | `admin_review` | `live` | `paused` | `ended`), approved_by (jsonb: user ids + timestamps), went_live_at
- **launch_files**: launch_id, storage_key, filename, size_bytes
- **license_keys**: launch_id, key, order_id (nullable until assigned)
- **tracked_links**: launch_id, owner_user_id, code (unique, 8 chars base62), label, discount_code (nullable)
- **link_clicks** (append-only): tracked_link_id, clicked_at, referrer, country, ua_hash, visitor_id (cookie)
- **orders**: launch_id, buyer_email, stripe_checkout_session_id (unique), stripe_payment_intent_id, amount_gross_cents, tax_cents, stripe_fee_cents, currency, tracked_link_id (nullable), status (`paid` | `refunded` | `partially_refunded` | `disputed`), paid_at
- **access_grants**: order_id, token (random 32 bytes, base64url, unique), revoked_at
- **refunds**: order_id, amount_cents, stripe_refund_id, reason, created_at

### Money
- **stripe_accounts**: user_id (unique), stripe_account_id, charges_enabled, payouts_enabled, details_submitted, country, updated_from_stripe_at
- **ledger_entries** (append-only): order_id (nullable), refund_id (nullable), user_id (nullable = platform), account (`creator_share` | `builder_share` | `platform_fee` | `stripe_fee` | `tax` | `adjustment`), amount_cents (signed), currency, available_at (paid_at + HOLD_DAYS), transfer_id (nullable), created_at
- **transfers**: user_id, stripe_transfer_id, amount_cents, currency, status, created_at

### Trust & ops
- **disputes**: collab_id, raised_by_user_id, kind (`split` | `non_delivery` | `exit` | `other`), description, status (`open` | `in_review` | `resolved`), resolution_note, resolved_by
- **notifications**: user_id, type, payload (jsonb), read_at
- **notification_prefs**: user_id, type, email (bool), in_app (bool)
- **events**: see §11
- **admin_audit_log** (append-only): admin_user_id, action, target_type, target_id, before (jsonb), after (jsonb)

Indexes: every FK, `ideas(status)`, `products(status)`, `matches(subject_user_id, status, score desc)`, `orders(launch_id, paid_at)`, `ledger_entries(user_id, available_at)`, `events(type, occurred_at)`, `events(subject_id)`. Use HNSW indexes on all `embedding` columns.

---

## 6. Auth & authorization

- Login: magic link, Google, GitHub (Auth.js). Session stores user id; roles are loaded per request.
- Middleware:
  - `/app/*` and `/onboarding/*` require a session.
  - `/admin/*` requires the `admin` role.
  - Users with incomplete onboarding are redirected from `/app` to the next onboarding step.
- `lib/auth/authz.ts` exports pure functions, e.g. `canViewCollab(user, collab)`, `canEditLaunch(user, launch)`, `canSendProposal(user, target)`. Every server action and every page loader calls one.
- Collab data is visible only to its members and admins. Public profile pages expose only fields marked public.
- Admin impersonation is **read-only** and logged to `admin_audit_log`.

---

## 7. Integrations

### 7.1 Social connections (data, not login)
Implement a common interface in `lib/social/types.ts`:

```ts
interface SocialProvider {
  authUrl(state: string): string
  exchangeCode(code: string): Promise<TokenSet>
  refresh(token: TokenSet): Promise<TokenSet>
  fetchProfile(token: TokenSet): Promise<SocialProfile>
  fetchAudience(token: TokenSet): Promise<AudienceSnapshotInput> // fields nullable where API doesn't provide
}
```

| Provider | Phase | What to pull | Caveats to verify before building |
|---|---|---|---|
| YouTube (Data API + YouTube Analytics API) | MVP, build first | Subscribers, recent video views, engagement, top countries, age/gender for the channel owner | Google OAuth app verification for sensitive scopes |
| Instagram (Instagram API with Instagram Login) | MVP | Followers, media insights, audience demographics | Works only for Business/Creator accounts; demographics need a follower minimum; Meta App Review required |
| TikTok (Login Kit + Display API) | MVP | Profile stats, recent video stats | Audience demographics are likely unavailable; app review required |
| GitHub | MVP (builders) | Public repos, stars, languages, contribution signal | Read-only scopes |

**Before writing each provider:** fetch the provider's current docs and confirm scopes, rate limits, and review requirements. List anything that differs from this table and ask me before proceeding. Meta and TikTok reviews take weeks, so YouTube and GitHub must work end-to-end without them.

**Sync flow:** OAuth callback → store encrypted tokens → enqueue `social/sync` → write an `audience_snapshot` → regenerate `audience_summary` (Claude) and the profile `embedding` → recompute `size_tier`. Re-sync daily. On token failure, set `status = expired` and notify the user.

**Fallback:** if a provider's API is not approved yet, allow manual entry of follower count plus a screenshot upload, flagged `unverified`. Admins can verify manually.

### 7.2 Stripe
- **Connect Express** for creators and builders. Onboarding via Account Links, at `/onboarding/payouts` and `/app/settings/payouts`. Sync account status from the `account.updated` webhook.
- **Checkout**: the platform is the charging party. Pass `metadata: { order_ref, launch_id, tracked_link_id }`. Enable **Stripe Tax** (digital goods, EU VAT).
- **Separate charges and transfers**: after the hold period, create one transfer per user per batch, using `source_transaction` where possible.
- Webhooks (verify signatures; idempotent by event id, stored in a `stripe_events` table): `checkout.session.completed`, `charge.refunded`, `charge.dispute.created`, `account.updated`, `transfer.reversed`.
- Test mode in all non-production environments. Provide a `pnpm stripe:listen` script.

### 7.3 Claude API (`lib/ai/claude.ts`)
Keep all prompts in `lib/ai/prompts/` as versioned functions. Store `prompt_version` with every output. Uses:
1. **Audience summary**: snapshot data → 3–5 sentences plus topics[]. The creator can edit it on `/onboarding/creator/review`.
2. **Idea brief drafter**: pasted audience comments → structured idea fields (Zod-validated JSON).
3. **Match explanation**: match features → one plain-language sentence. Cache it on `matches.explanation`.
4. **Launch kit copy**: launch plus creator profile → 3 post drafts per platform.

Always validate LLM JSON with Zod. Retry once, then fall back to empty fields. Never block a user flow on the LLM.

### 7.4 Email (Resend)
Templates: magic link, proposal received / countered / accepted, agreement ready to sign, agreement fully signed (PDF attached), launch approved / live, sale made (to both parties), payout sent, buyer receipt and access link, refund confirmation, dispute opened.

---

## 8. Matching v0

Recompute nightly, and on demand when a profile, idea, or product changes (Inngest, debounced 10 min).

**Candidates:**
- For a creator: open products, plus builders with `availability ≠ closed`.
- For a builder: open ideas, plus creators with verified connections.
- Exclude yourself, dismissed items, and suspended users.

**Features** (each normalised to the range 0–1):

| Feature | Definition |
|---|---|
| `semantic` | Cosine similarity of embeddings (idea/product ↔ profile, or profile ↔ profile) |
| `topic_overlap` | Jaccard overlap of topic sets |
| `format_fit` | 1 if the builder has a shipped portfolio item of the same format, else 0.5 |
| `audience_fit` | Language overlap × geo overlap (0.5 when unknown) |
| `price_fit` | 1 − (absolute difference between the idea's target price and the product's price ÷ the larger of the two), clamped to 0–1 |
| `reliability` | Starts at 0.5. Updated from history: completed collabs ↑, disputes ↓. |
| `stage_fit` | Larger creators score higher with beta/live products; smaller creators with idea/prototype (lookup table in code) |

**Score:**

```
score = 0.35 × semantic
      + 0.20 × topic_overlap
      + 0.15 × audience_fit
      + 0.10 × format_fit
      + 0.10 × stage_fit
      + 0.05 × price_fit
      + 0.05 × reliability
```

Weights live in a config table (`matching_config`) with a `model_version`. Store the full feature vector on every `matches` row. That stored vector is the training data for v1. Show the top 30 per user. The explanation names the top two contributing features in plain language.

**v1 (Phase 7):** once ≥ 50 completed launches exist, fit a logistic model that predicts "proposal accepted" and "launch made ≥ 1 sale" from the stored features. Compare against v0 on held-out data in `/admin/matching` before switching.

---

## 9. Money flow & ledger

**On `checkout.session.completed`** (one DB transaction, idempotent):
1. Create the `order` (status `paid`) and an `access_grant`. Assign a license key if `delivery_type = license_key`.
2. Retrieve the balance transaction to get the real Stripe fee.
3. Compute the split with `lib/ledger/split.ts` (a pure function with unit tests):
   - `net = gross − tax − stripe_fee`
   - `platform_fee = round(net × PLATFORM_TAKE_RATE)` (default 10%, configurable)
   - `distributable = net − platform_fee`
   - Each member's share = `distributable × split_pct ÷ 100`, using the **largest-remainder method** so shares sum exactly to `distributable`. Ties go to the member with the lower user id (deterministic).
4. Write ledger entries for every component. They must sum to `gross` (assert in code).
5. Set `available_at = paid_at + HOLD_DAYS` (default 14).
6. Emit `order.paid`. Email the buyer (access link) and both members (sale notice).

**Daily payout job:** for each user with `payouts_enabled`, sum available, untransferred, positive entries. If the sum is ≥ `MIN_PAYOUT_CENTS`, create a Stripe transfer, then mark the entries with `transfer_id`.

**Refunds:**
- Write negative mirror entries, proportional for partial refunds.
- If the original entries were already transferred, create a transfer reversal and record it.
- Revoke the access grant on a full refund.

**Disputes (chargebacks):** mark the order `disputed`, freeze related untransferred entries, notify admin.

Build a reconciliation script, `pnpm ledger:check`. It asserts that for every order, entries sum to gross minus refunds, and that transfer totals match Stripe.

---

## 10. Attribution

- `/r/[code]`: log a `link_click`, set cookie `attr=<tracked_link_id>` (30 days, last-click wins), then 302 to `/p/[slug]`. Bot user agents are logged but flagged.
- Checkout reads the cookie (or a `?ref=` fallback) into the session metadata. A discount code tied to a tracked link also attributes.
- Collab analytics funnel: clicks → product page views (event) → checkout started (event) → paid orders. Break it down by tracked link.

---

## 11. Event log (the dataset)

Table **events** (append-only): id, type, occurred_at, actor_user_id (nullable), subject_type, subject_id, properties (jsonb), context (jsonb: ip_country, ua_hash, session id).

Use `track(type, {...})` from `lib/events/track.ts`, with event types as a typed union. Write events in the same transaction as the state change where possible. Required events:

```
user.signed_up, user.role_added, onboarding.completed
social.connected, social.synced, social.expired
idea.created, idea.published, idea.archived
product.created, product.published, product.archived
match.computed (batch summary), match.shown, match.clicked, match.saved, match.dismissed
proposal.sent, proposal.countered, proposal.accepted, proposal.declined, proposal.expired
collab.created, collab.stage_changed, collab.ended
agreement.generated, agreement.signed (per party), agreement.completed
task.completed, message.sent (count only, no body)
launch.submitted, launch.approved (per party), launch.live, launch.paused
link.clicked, product_page.viewed, checkout.started, order.paid, order.refunded, order.disputed
payout.sent, dispute.opened, dispute.resolved
ai.generated (prompt_version, use, latency_ms, accepted_by_user bool)
```

Never put message bodies, emails, or tokens into event properties.

---

## 12. Routes (must match the Page Map doc)

**Public:** `/`, `/creators`, `/builders`, `/how-it-works`, `/pricing`, `/launches` (v1), `/c/[handle]`, `/b/[handle]`, `/legal/terms`, `/legal/privacy`, `/legal/agreement`

**Auth/onboarding:** `/sign-up`, `/sign-in`, `/onboarding/role`, `/onboarding/creator/profile`, `/onboarding/creator/connect`, `/onboarding/creator/review`, `/onboarding/builder/profile`, `/onboarding/builder/portfolio`, `/onboarding/payouts`

**App (signed in):**
- Home: `/app` (role-aware)
- Creator: `/app/audience`, `/app/ideas`, `/app/ideas/new`, `/app/ideas/[id]`
- Builder: `/app/products`, `/app/products/new`, `/app/products/[id]`
- Discovery: `/app/discover`, `/app/discover/creators`, `/app/discover/builders`, `/app/discover/briefs`, `/app/discover/saved` (v1)
- Proposals: `/app/proposals`, `/app/proposals/new`, `/app/proposals/[id]`
- Collabs: `/app/collabs`, `/app/collabs/[id]`, `/app/collabs/[id]/agreement`, `/app/collabs/[id]/tasks`, `/app/collabs/[id]/messages`, `/app/collabs/[id]/launch`, `/app/collabs/[id]/analytics`
- Launches: `/app/launches`, `/app/launches/[id]/kit`, `/app/launches/[id]/links` (v1)
- Inbox: `/app/messages`, `/app/notifications`
- Earnings: `/app/earnings`, `/app/earnings/payouts`
- Settings: `/app/settings/profile`, `/app/settings/connections`, `/app/settings/payouts`, `/app/settings/notifications`, `/app/settings/account`

**Buyer:** `/r/[code]`, `/p/[slug]`, `/p/[slug]/checkout`, `/p/[slug]/success`, `/access/[token]`, `/access/[token]/refund` (v1)

**Admin:** `/admin`, `/admin/users`, `/admin/collabs`, `/admin/launches`, `/admin/disputes`, `/admin/payouts`, `/admin/events` (v1), `/admin/matching` (v1)

**Key page behaviours** (see the Page Map for the full purpose of each page):
- `/app` shows different widgets per `active_role`. A role switcher in the sidebar changes it.
- `/app/proposals/new` takes `?to=<userId>&idea=<id>` or `&product=<id>`. It is blocked unless the sender has completed onboarding.
- **Agreement page:**
  - Renders the template (`lib/agreements/template-v1.tsx`) with a terms snapshot.
  - The "Sign" button requires typing your full name and both parties having `payouts_enabled`.
  - When both have signed: generate the PDF, store it in R2, set collab stage to `building`, and email the PDF.
- **Launch setup page:**
  - Either member edits; saving resets approvals.
  - Each member clicks "Approve". When both have approved, the launch goes to `admin_review` (MVP) or straight to `live` (once `AUTO_APPROVE_LAUNCHES=true`).
  - Going live creates a default tracked link for the creator.
- `/p/[slug]` is statically rendered and revalidated when the launch changes. It shows "by @creator × @builder".
- `/access/[token]` serves files via short-lived signed R2 URLs (5 min), shows license keys, or redirects to the URL delivery target.

---

## 13. Background jobs (Inngest)

| Function | Trigger | Does |
|---|---|---|
| `social/sync` | On connect, daily cron | Pull snapshot, update summary, embedding, size tier |
| `embeddings/refresh` | Profile/idea/product change | Re-embed, debounced |
| `matching/recompute` | Nightly; on change (debounced) | Recompute matches for affected users |
| `proposals/expire` | Hourly | Expire pending proposals past `expires_at` |
| `payouts/release` | Daily 06:00 UTC | Transfers for available balances |
| `reminders/stalled` | Daily | Nudge collabs with no activity for 7 days; unsigned agreements after 3 days |
| `ledger/check` | Daily | Run reconciliation; alert to Sentry on mismatch |

All functions must be idempotent and use step functions for retries.

---

## 14. Security, privacy, compliance

- GDPR:
  - Data export (JSON) and account deletion at `/app/settings/account`.
  - Deletion anonymises the user. It keeps ledger and orders, which are legally required, with personal data removed.
  - Disconnecting a social account deletes its tokens and snapshots.
- Encrypt OAuth tokens at rest. Never log them.
- Verify Stripe webhook signatures. Use a `state` parameter plus PKCE on all OAuth flows.
- Rate limiting (Upstash or similar): auth, proposal sending (max 20/day per user), message sending, `/r/*`, checkout.
- Signed URLs for all private files. Upload limits: 200 MB per deliverable file, 25 MB per attachment. Allow-list MIME types.
- Sanitize user markdown (product descriptions, messages) before rendering.
- Every admin action is written to `admin_audit_log`.

---

## 15. Testing

- **Unit:** `ledger/split.ts` (rounding, uneven splits, refunds, partial refunds, zero-fee edge cases), `matching/score.ts`, authz functions, Zod schemas.
- **Integration:** webhook handlers against Stripe test fixtures (replayed events, duplicates must be no-ops), social providers against recorded fixtures.
- **E2E (Playwright), one happy path:**
  1. Creator and builder sign up and complete onboarding (social and Stripe mocked).
  2. Builder sends a proposal; creator counters; builder accepts.
  3. Both sign the agreement; the launch is configured and approved by both and admin.
  4. A buyer clicks the tracked link and pays with a Stripe test card.
  5. Access works; the ledger is correct; the payout job transfers after the hold (clock mocked).
- Seed script `pnpm db:seed`: 10 creators, 10 builders, ideas, products, 3 collabs in different stages, 1 live launch with orders.

---

## 16. Build phases & acceptance criteria

**Phase 0 — Foundation**
Repo, tooling, CI (GitHub Actions: typecheck, lint, test), DB plus migrations, Auth.js, base layouts for marketing, app (sidebar), and admin, the `events` table with `track()`, Sentry, and env validation (Zod).
✅ A user can sign up, sign in, sign out. `/admin` is blocked for non-admins. CI is green.

**Phase 1 — Profiles & onboarding**
Role selection, creator/builder profile forms, public profiles, YouTube + GitHub connections with sync, audience snapshot and summary, manual-entry fallback, settings pages (profile, connections, account), Stripe Connect onboarding.
✅ A creator connects YouTube and sees `/app/audience` with real data. A builder connects GitHub. Both complete Stripe test onboarding. `/c/[handle]` and `/b/[handle]` render.

**Phase 2 — Supply, demand, discovery**
Ideas and products CRUD, embeddings, matching v0, discover pages, saved items (v1 if time), match explanations.
✅ The seeded users see ranked matches with explanations. Dismiss and save persist. Events are logged.

**Phase 3 — Proposals & collaboration**
Proposals with counters, threads and messages, notifications (in-app plus email), collabs, the agreement template, click-sign, PDF, tasks.
✅ Two users go from proposal to a fully signed agreement. The PDF is stored and emailed. The collab is in `building`.

**Phase 4 — Launch & checkout**
Launch setup, dual approval, admin review, `/p/[slug]`, tracked links, `/r/[code]`, Stripe Checkout + Tax, order creation, delivery (file / license key / URL), `/access/[token]`, launch kit with AI post drafts.
✅ A test purchase via a tracked link creates an attributed order, and the buyer gets working access.

**Phase 5 — Ledger & payouts**
Split computation, ledger, earnings pages, payout job, refunds, chargebacks, reconciliation.
✅ `pnpm ledger:check` passes on seeded data plus randomized property tests. The payout transfers correct amounts in test mode. Refunds reverse correctly.

**Phase 6 — Admin & trust**
Admin overview, users, collabs, launches, disputes, payouts, audit log, read-only impersonation, rate limits, GDPR export and delete.
✅ Admin can resolve a dispute and make an audited ledger adjustment.

**Phase 7 — Analytics & learning (v1)**
Collab analytics funnel, `/admin/events` explorer, `/admin/matching` comparison, matching v1 model behind a flag, `/launches` directory, `/app/launches/[id]/links`, `/access/[token]/refund`.
✅ Admin sees funnel conversion by match-score bucket. The v1 model is evaluated against v0.

**Later (not in this build):** operator agent (`/app/agent`), opportunities feed, idea validation pre-sales, launch copilot. Do not scaffold these pages.

---

## 17. Environment variables

```
DATABASE_URL
AUTH_SECRET, AUTH_URL
AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET
RESEND_API_KEY, EMAIL_FROM
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
GOOGLE_YT_CLIENT_ID, GOOGLE_YT_CLIENT_SECRET
META_APP_ID, META_APP_SECRET
TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
GITHUB_DATA_CLIENT_ID, GITHUB_DATA_CLIENT_SECRET
ANTHROPIC_API_KEY, ANTHROPIC_MODEL
EMBEDDINGS_PROVIDER, VOYAGE_API_KEY
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY
ENCRYPTION_KEY
SENTRY_DSN, NEXT_PUBLIC_POSTHOG_KEY
PLATFORM_TAKE_RATE=0.10
HOLD_DAYS=14
MIN_PAYOUT_CENTS=1000
AUTO_APPROVE_LAUNCHES=false
YOUTUBE_LONG_RETENTION=false
APP_NAME, NEXT_PUBLIC_APP_URL
```

Validate all of them at boot in `lib/env.ts`.

---

## 18. Open decisions (ask Trifon before building the affected part)

1. **Merchant of record.** In this spec the platform charges via Stripe and handles EU VAT with Stripe Tax, so the platform is the seller. The alternative is a merchant of record (Paddle, Lemon Squeezy), which handles VAT liability but makes multi-party splits harder. This affects Phases 4–5.
2. **Agreement template.** The v1 template needs review by a Spanish/EU lawyer before real money flows: IP ownership, exit and buyout terms, governing law.
3. **Take rate and hold period.** Defaults are 10% and 14 days. Confirm.
4. **Builder-only products** (a builder lists a product and a creator just promotes it, affiliate-style): same collab flow, or a lighter "promote" flow? MVP assumes the same flow.
5. **Company/brand accounts:** out of scope for now. Do not add the role.

---

## 19. Implementation notes (decisions made during the build)

> Added during the build. Each entry records a decision this file did not make, or a place where reality differed from it. Update entries when they change.

### 19.1 Repo layout
- The platform lives at the repo root (§3). The repo also holds the **legacy Vincera Bot** (Python agent and its own Next.js dashboard): `vincera/`, `dashboard/`, `supabase/`, `tests/*.py`, `tests/conftest.py`, `install.sh`, `install.ps1`, `pyproject.toml`, `requirements.txt`. **Do not modify legacy files.** TypeScript, ESLint, Vitest, Tailwind and Next.js config exclude them. Platform tests live only in `tests/unit`, `tests/integration` and `tests/e2e`.
- The companion **Page Map** doc is not in the repo. §12 is the source of truth for routes.
- `AGENTS.md` at the root holds Next.js's managed agent-rules block. `next dev` appends that block to `CLAUDE.md` when it detects an AI agent and no file contains it; keeping it in `AGENTS.md` leaves this file alone. Do not delete it.
- Root tooling: `next.config.ts` (Sentry wrapper), `instrumentation.ts` / `instrumentation-client.ts` / `sentry.*.ts`, `eslint.config.mjs`, `.prettierrc.json`, `vitest.config.mts`, `playwright.config.ts`, `drizzle.config.ts` (schema `lib/db/schema`, out `drizzle/`), `components.json`, `pnpm-workspace.yaml` (build-script allow-list).
- Scripts run with `tsx --tsconfig tsconfig.scripts.json`, which maps `server-only` to Next's no-op module so scripts can import server modules; Vitest aliases it the same way. `scripts/lib/db-admin.ts` (`recreateDatabase`, `runMigrations`) takes explicit URLs and never reads `lib/env`, so test global setups can use it. Its `runScript` prints an error's message plus its `cause` chain (Drizzle hides driver errors such as `database "x" does not exist` in the cause). `pnpm db:migrate` needs an existing database; `pnpm db:reset` creates it (the README's first-run step).

### 19.2 Library realities
- **Auth.js:** the stable `next-auth` release is v4. App Router support is v5, which is published only as `next-auth@beta`. We use v5 beta with `@auth/drizzle-adapter`. All auth code is contained in `lib/auth/`.
- **Auth.js v5 beta quirks:** with a per-request config (`NextAuth(request => config)`), `auth(handler)` returns a *promise* of the middleware although its types say it returns the middleware, so `proxy.ts` awaits it inside its own `proxy` function (Next 16 rejects a default export that is not a function). The middleware overload is only picked when the handler declares both `(request, event)` parameters. `next-auth` imports `next/server` without an extension, which Node's ESM resolver rejects, so Vitest inlines `next-auth` (`server.deps.inline`).
- **Drizzle:** we use the latest stable 0.x release. 1.0 is still an RC.
- **TypeScript:** 6.0.x, the newest 6.x. TypeScript 7 (native compiler) is the latest release and `next build` can type-check with it, but typescript-eslint supports only `<6.1` and TS 7 has no JS API yet.
- **ESLint:** 9, not 10. The react, import and jsx-a11y plugins bundled by `eslint-config-next` do not support ESLint 10 yet (create-next-app also pins `^9`). Upgrade when they do.
- **shadcn/ui:** `components/ui/*` were written by hand from shadcn's "new-york" sources (Radix via the unified `radix-ui` package, Tailwind v4, neutral, CSS variables), because the shadcn registry (`ui.shadcn.com`) is blocked by the build sandbox's network policy. `components.json` is set up, so `pnpm dlx shadcn@latest add <name>` works wherever the registry is reachable. Components use the Radix `asChild` API, not Base UI's `render` prop.
- **React Email:** v6 deprecated `@react-email/components`; components and `render` now come from `react-email` (a runtime dependency that also provides the `email` CLI). `@react-email/render` stays installed as Resend's peer.
- **Markdown:** `marked` + `sanitize-html` (server-side, no jsdom).
- **Sentry v11:** `withSentryConfig` is imported from `@sentry/nextjs/config`. `sendDefaultPii` was replaced by `dataCollection`, whose defaults collect cookies, headers, bodies, query strings and AI inputs/outputs; `sentry.shared.ts` turns all of that off (§11, §14). Source maps upload only when `SENTRY_AUTH_TOKEN` is set.
- **Fonts:** Geist from the `geist` package (`next/font/local`), so builds never download fonts.
- `@types/node` is pinned to `^22` to match the Node engine. msw 3 is installed; vitest's browser-mode mocker still declares msw `^2` (peer warning silenced in `pnpm-workspace.yaml`).

### 19.3 External services: real vs fake
Every external integration sits behind a small interface with a **live** and a **fake** implementation. A service uses **live** when its credentials are present, otherwise **fake**. `FAKE_SERVICES=all` (or a comma list such as `stripe,social`) forces fakes; e2e and CI use `FAKE_SERVICES=all`. In `NODE_ENV=production`, fakes are forbidden and `lib/env.ts` fails at boot if credentials are missing. Fakes keep their state in the DB or under `.data/` (gitignored), never in a module-level variable, so they survive across Next.js workers.

| Service | Live | Fake |
|---|---|---|
| Email | Resend | Outbox: JSON files in `.data/outbox/`; e2e reads magic links from there |
| Storage | Cloudflare R2 (S3 API) | Local disk at `.data/storage/` with HMAC-signed, expiring URLs served by a dev route |
| Stripe | Stripe API (test mode outside prod) | Fake checkout page, fake Connect onboarding, fake transfers. Webhooks are sent to our real `/api/webhooks/stripe` handler, signed with `STRIPE_WEBHOOK_SECRET`, so the real handler code path runs |
| Social (YouTube, Instagram, TikTok, GitHub) | Provider APIs | Fake authorize page that redirects back to the real callback; fixture profile and audience data |
| Claude | Anthropic SDK | Deterministic stub outputs (exercises the Zod validation and fallback path) |
| Embeddings | Voyage AI | Deterministic hashed bag-of-words vectors, 1024-dim, L2-normalised |
| Jobs | Inngest | `inline`: handlers run in-process right after the triggering request |
| Rate limiting | Upstash (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) | In-memory per process |
| Sentry / PostHog | When DSN/key set | No-op |

- **`APP_ENV`** (`development` | `test` | `production`, default derived from `NODE_ENV`) decides what "production" means for `lib/env.ts`, fakes and test routes. `next build && next start` always runs with `NODE_ENV=production`, so e2e and CI set `APP_ENV=test` to keep fakes allowed. A real deployment sets nothing and is strict.
- `lib/env.ts` API: `env` (lazy, parsed once), `getEnv()`, `parseEnv(source)` (pure, for tests), `isFake(service)`, `isSocialProviderFake(provider)`, `isProduction()`, `testRoutesEnabled()`, `isAdminEmail(email)`, `validateEnvAtBoot()`. Client code uses `publicEnv` from `lib/public-env.ts` (`NEXT_PUBLIC_*` only).
- Always required, in every environment: `DATABASE_URL`, `AUTH_SECRET` (32+ chars), `ENCRYPTION_KEY` (32 bytes, base64) and `STRIPE_WEBHOOK_SECRET` (fake Stripe signs its webhooks with it). In production every §17 variable without a `=default` is required (`APP_NAME` included: it brands every page and email), plus `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, because in-memory rate limiting is a fake. Outside production, live Stripe keys (`sk_live_`/`rk_live_`) are rejected (§7.2).
- Production also refuses `INNGEST_DEV` (any value: Inngest's dev mode accepts unsigned requests on `/api/inngest`) and the secret values committed to this repo (`PUBLISHED_SECRET_VALUES` in `lib/env.ts`: the `.env.example` webhook secret and CI's `AUTH_SECRET` / `ENCRYPTION_KEY` / `STRIPE_WEBHOOK_SECRET`). A unit test reads `.env.example` and `ci.yml` and fails when a committed secret value is missing from that list.
- Defaults outside production: `ANTHROPIC_MODEL=claude-opus-5-5`, `EMBEDDINGS_PROVIDER=voyage`, `EMAIL_FROM="<APP_NAME> <onboarding@resend.dev>"`, `NEXT_PUBLIC_APP_URL=http://localhost:3000`, `APP_NAME=Vincera`.
- Extra optional variables: `ADMIN_EMAILS` (comma list, admin role on sign-up), `NEXT_PUBLIC_POSTHOG_HOST` (default `https://eu.i.posthog.com`), `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` (build-time source maps). `NEXT_PUBLIC_SENTRY_DSN` is not set by hand: `next.config.ts` copies `SENTRY_DSN` into it for the browser SDK.
- `isFake('social')` is true only when social fakes are forced or no provider has credentials. Code for a specific provider must call `isSocialProviderFake(provider)`, since Meta/TikTok credentials may arrive later than YouTube/GitHub.
- Boot: `instrumentation.ts` calls `validateEnvAtBoot()`. On a bad configuration a `NODE_ENV=production` server logs the problems and exits with code 1; `next dev` rethrows and stays up. During `next build` the production-only checks are skipped.

### 19.4 Testing
- Integration tests run against real Postgres + pgvector. Each test run clones a freshly migrated template database, so parallel runs don't collide. Locally, set `TEST_DATABASE_URL`. CI uses a `pgvector/pgvector` service container.
- E2E runs `next build && next start` (or `next dev` locally) against a dedicated e2e database that is reset, migrated and seeded before the run, with `FAKE_SERVICES=all`.
- Test-only routes under `/api/test/*` (run a job with a mocked clock, read the outbox) exist only when `E2E_TEST_ROUTES=1` **and** `NODE_ENV !== 'production'`. Built so far: `POST /api/test/jobs/<job id>` (§19.11). There is no outbox route: Playwright runs on the server's machine and reads `.data/outbox/` through `lib/email/outbox.ts`.
- Time: business logic takes `now` from `lib/clock.ts`, never from `new Date()` directly, so jobs can run with a mocked clock.
- Because e2e runs `next start` (`NODE_ENV=production`), the `/api/test/*` rule is implemented as `E2E_TEST_ROUTES=1` **and** `APP_ENV !== 'production'`: use `testRoutesEnabled()` from `lib/env.ts`.
- ESLint forbids `new Date()` with no arguments and `Date.now()` in `lib/**` and `inngest/**` (except `lib/clock.ts`). `lib/clock.ts` offers `now()`, `runWithClock(date, fn)` (AsyncLocalStorage, safe inside a running server, e.g. a test route) and `setClockForTests(date | null)` (refused when `NODE_ENV=production`).
- Vitest has two projects: `unit` (`tests/unit/**/*.test.ts`) and `integration` (`tests/integration/**/*.test.ts`, global setup `tests/integration/global-setup.ts`). `pnpm test` runs both and passes when a project has no tests yet.
- Playwright: `tests/e2e`, Chromium only, `workers: 1`, port 3100 (`PORT`). The web server gets `APP_ENV=test`, `FAKE_SERVICES=all`, `E2E_TEST_ROUTES=1`, `DATABASE_URL=$E2E_DATABASE_URL` (default `creator_e2e`), and `AUTH_URL` / `NEXT_PUBLIC_APP_URL` pointing at port 3100. `E2E_DATABASE_URL` is read from the environment, else `.env.local` / `.env`, else the default (like `TEST_DATABASE_URL`); the config exports it to `process.env` for `tests/e2e/global-setup.ts`. When `/opt/pw-browsers/chromium` exists (the build sandbox) it is used instead of Playwright's own download; never run `playwright install` there. Specs import `test`/`expect` from `tests/e2e/fixtures.ts` (ESLint enforces it): each test sends its own `x-forwarded-for` (IPv6 documentation range), so per-IP rate limits apply per test as they would per person. Without it every test, and every run against a reused dev server, shared localhost's `auth` budget (10 magic links per 10 min) and the 11th request failed.
- CI (`.github/workflows/ci.yml`): one job with a `pgvector/pgvector:pg17` service, `APP_ENV=test`, `FAKE_SERVICES=all`, test-only secrets; runs install (frozen lockfile), typecheck, lint, `pnpm test`, `pnpm build`, `playwright install --with-deps chromium`, `pnpm test:e2e`, and uploads the Playwright report on failure. `.next/cache` is cached between runs (`actions/cache`, keyed on the lockfile). Playwright's web server builds again in CI because `NEXT_PUBLIC_*` values are inlined at build time and e2e serves on port 3100; that second build reuses the cache. pnpm comes from `packageManager` in `package.json` (`pnpm/action-setup` without a `version`). Phase 0 gate (run as CI does, from a clean copy and a fresh Postgres cluster): all six steps green.
- **Integration test databases** (`tests/helpers/db-template.ts`, `tests/helpers/db.ts`): the global setup creates one template database per migration set, `ct_tpl_<hash of drizzle/>_<time>`, under a Postgres advisory lock (parallel runs don't race), then freezes it (`IS_TEMPLATE`, `ALLOW_CONNECTIONS false`). Each test **file** calls `setupTestDatabase()`, which clones the template (`CREATE DATABASE ... TEMPLATE ...`) in `beforeAll` and drops it in `afterAll`. Clones are named after the run (`ct_<time>_<rand>_<rand>`); the run's teardown drops any a crashed file left. The sweep in later runs drops only names that match the exact generated grammar (`isOwnTestDatabase`; never something like `ct_shop`): clones older than 6 hours, abandoned `ct_build_*` databases, and templates of other migration sets unused for 24 hours. Every run records its template's last use in the database comment (`ct:last_used=<ms>`) under the advisory lock, so a template another branch or worktree is cloning from is never swept. The admin connection is `TEST_DATABASE_URL` (environment, else `.env.local` / `.env`, else `postgres://postgres:postgres@localhost:5432/postgres`).
- Test tooling that creates or drops databases (integration template setup, e2e reset) runs only against a local Postgres (`assertTestServer` in `scripts/lib/db-admin.ts`) unless `ALLOW_REMOTE_TEST_DB=1` says the other server holds only test databases. CI's service container is on localhost.
- Code under test takes a `DbOrTx` argument; tests pass `testDb.db` (or a transaction). Nothing global is swapped. Fixtures live in `tests/helpers/db-fixtures.ts`; `expectPgError(query, PG_ERROR.x, constraint?)` asserts database errors.
- `tests/e2e/global-setup.ts` refuses databases whose name lacks a whole `e2e`/`test` word (`isTestDatabaseName`: `creator_e2e` yes, `attestations` no) or that live on a non-local host (`assertTestServer`, see below), then drops and re-creates `E2E_DATABASE_URL`, migrates, runs `pnpm db:seed`, and empties `.data/` (fake outbox, storage, ...). Playwright starts the web server **before** global setup, so the reset happens under a running server; the pg pool has an `error` handler and reconnects.
- Auth tests: `tests/integration/auth/auth-flow.test.ts` drives the real Auth.js handlers with our config and an injected test database (`createAuthConfig(request, { db, env })`), capturing magic links by mocking `sendMagicLinkEmail`. E2E reads magic links from the fake outbox (`tests/e2e/helpers/auth.ts`); the Playwright web server sets `ADMIN_EMAILS=e2e-admin@example.com` (`tests/e2e/helpers/accounts.ts`), and every other e2e account uses a fresh random address so retries never collide.

### 19.5 Data model
- Schema: `lib/db/schema/` split into `enums.ts`, `types.ts` (jsonb shapes), `columns.ts` (helpers), `identity.ts`, `social.ts`, `supply.ts`, `matching.ts`, `collab.ts`, `commerce.ts`, `money.ts`, `trust.ts`, `events.ts`, `relations.ts`; import everything from `@/lib/db/schema`. Schema files use relative imports (drizzle-kit loads them without the `@/` alias) and must not import `server-only` modules.
- Every §5 status/kind is a `pgEnum`; values are exported (`ideaStatusEnum.enumValues`, TS unions such as `IdeaStatus`) for Zod and UI. `target_type` is shared by `matches` and `saved_items`; `product_format` by ideas, products and portfolio items. Where §5 leaves a set open, columns are plain text: `events.type` / `subject_type`, `notifications.type`, `notification_prefs.type`, `admin_audit_log.action` / `target_type`.
- Timestamps: `created_at` / `updated_at` are filled by the app from `now()` (`lib/clock.ts`) via `$defaultFn` / `$onUpdate`, with a SQL `DEFAULT now()` for raw inserts, so mocked clocks apply to row timestamps. `proposals.expires_at` defaults to clock + 14 days (`PROPOSAL_TTL_DAYS`). Append-only tables have `created_at` only; `events` has only `occurred_at`; `sessions`, `verification_tokens` and `stripe_events` keep their own timestamp columns.
- **Auth.js tables:** `users` maps the adapter's `image` to `avatar_url` and `emailVerified` to `email_verified`; `accounts` (PK provider + provider_account_id, plus created_at/updated_at), `sessions`, `verification_tokens`. SQL names are snake_case. There is no `authenticators` table (no WebAuthn). Pass the tables explicitly: `DrizzleAdapter(db, { usersTable: users, accountsTable: accounts, sessionsTable: sessions, verificationTokensTable: verificationTokens })`; the adapter then keeps our UUIDv7 id default. Note: Auth.js writes login OAuth tokens to `accounts` in plaintext; we never use them, so `lib/auth` should drop them before they are stored (§4).
- `users.email` is unique but nullable, so GDPR deletion (§14) can null it. `roles` is `text[]` with a CHECK (subset of creator/builder/admin); `active_role` is the `user_role` enum and must be one of `roles` (CHECK).
- **Handles:** a `handles` registry (`handle` PK, `user_id`) makes handles unique across creators and builders. Profiles reference `(handle, user_id)`, so a profile can only use its own user's handle, and a creator and a builder profile of the same user may share it. Renames cascade (`ON UPDATE CASCADE`); a handle in use cannot be deleted. The `[a-z0-9_]{3,30}` format is a CHECK on all three columns (`HANDLE_PATTERN` / `HANDLE_REGEX` in TS).
- Columns added beyond §5, because other sections need them: `portfolio_items.format` (§8 `format_fit`), `products.target_price_cents` and `currency` on ideas/products (§8 `price_fit`), `creator_profiles.audience_summary_prompt_version` and `matches.explanation_prompt_version` (§7.3), `embedding_model` next to every `embedding` (re-embed on provider change), `launch_files.content_type` (§14 MIME allow-list), `link_clicks.is_bot` (§10), `audience_snapshots.countries_basis` (`audience_basis` enum: `viewers` | `followers`; a CHECK requires it when `top_countries` is non-empty), and on `social_connections` for the §7.1 manual fallback: `source` (`oauth` | `manual`, default `oauth`), `verified_at`, `evidence_storage_key` (`provider_account_id` and the token columns are nullable for manual rows).
- Tables added beyond §5: `stripe_events` (Stripe event id PK, type, payload, received_at, processed_at; webhook idempotency, §7.2) and `matching_config` (model_version unique, weights, active, notes; at most one active row). Migration `0003` inserts the active `v0` row with the §8 weights, and `matches.model_version` references it.
- `transfers.status` (§5 leaves it open): `pending` (row written before the Stripe call; the row id is the idempotency key, `stripe_transfer_id` still null) → `created`, or `failed`; refunds after payout set `reversed` / `partially_reversed` and add to `amount_reversed_cents` (§9 "record it").
- Extra integrity rules: proposals and collabs have exactly one of idea_id/product_id; no proposal to yourself; revision splits are 0–100 and sum to 100; a thread's kind matches its parent; at most one non-terminated agreement per collab; one signature per party; a launch past `draft` must have a price and a delivery type; slug and tracked-link code formats; member-share ledger accounts need a user and platform accounts (`platform_fee`, `stripe_fee`, `tax`) must not have one; one social connection per user and provider, and one platform user per provider account.
- `ON DELETE`: personal child rows of a user cascade (auth rows, handles, profiles, social connections, notifications, saved items); child rows of collabs (members, agreements, tasks, thread) and threads (messages, reads) cascade; everything that money, attribution or history hangs off is RESTRICT (proposals, ideas/products in deals, launches, orders, ledger, transfers, events). Users are anonymised, never hard-deleted.
- **Append-only at the DB level** (`drizzle/0002_append_only_guards.sql`): triggers reject UPDATE, DELETE and TRUNCATE on `events`, `audience_snapshots`, `proposal_revisions`, `agreement_signatures`, `link_clicks`, `admin_audit_log` with SQLSTATE `AO001` (`PG_ERROR.appendOnlyViolation`). `ledger_entries` also rejects them, except one UPDATE: setting `transfer_id` from NULL to a transfer with no other column changing (the payout job, §9). Because entries are immutable, a chargeback "freezes" untransferred entries by excluding orders in `disputed` status from the payout query, not by flagging entries.
- GDPR escape hatch: inside a transaction, `allowGdprErasure(tx)` (`lib/db/append-only.ts`) sets `app.gdpr_erasure` for that transaction only, which lets DELETE through on `audience_snapshots` (disconnecting a social account deletes its snapshots, §14). Updates and every other append-only table stay blocked; Phase 6 must extend the trigger explicitly if it needs to redact more.
- Migrations: `0000` enables pgvector (custom), `0001` is the generated schema, `0002` adds the append-only triggers (custom), `0003` seeds matching v0 (custom), `0004` adds `audience_snapshots.countries_basis` (generated), `0005` adds the Phase 1 columns (generated, §19.11).
- **Audience snapshot shapes:** the `audience_snapshots` columns store a provider's `AudienceSnapshotInput` (lib/social/types.ts) as it is: `age_gender` is `{ basis, buckets: { ageGroup, gender, share }[] } | null`, `top_countries` is `{ country, share }[]` with its basis in `countries_basis`, and `raw` is a JSON object (Zod `z.json()` values). YouTube shares are of viewers, Instagram's of followers, so the basis is never dropped. Gender is `female | male | other | unknown` (`other` = YouTube "user_specified", `unknown` = Instagram "U"). A compile-time check in lib/social/types.ts fails the typecheck when a field and its column drift apart. Add custom SQL with `pnpm db:generate --custom --name <name>`. Postgres truncates identifiers at 63 characters, so long foreign keys are named explicitly.
- `lib/db/client.ts`: `db` (lazy, connects on first use like `env`) / `getDb()`, `createDb(url)` for scripts and tests, `closeDb()`, `withTransaction(fn, dbOrTx?)` (nested calls become savepoints), types `Db`, `Tx`, `DbOrTx`. Queries live in `lib/db/queries/<domain>.ts` and take `DbOrTx` first. `lib/db/errors.ts` (`getPgError`, `isPgError`, `PG_ERROR`) unwraps drizzle's `DrizzleQueryError`. Its message includes the query parameters, so never show it to users or send it to Sentry unscrubbed.

### 19.6 Event log
- The catalog is `EventCatalog` in `lib/events/types.ts`: every event's subject type and exact properties, plus the runtime lists `EVENT_TYPES` and `SUBJECT_TYPES`. Properties are snake_case ids, enums, counts and amounts only. Added beyond §11: `proposal.withdrawn` (the status exists, so the transition needs an event), and the Phase 1 events listed in §19.11. `ai.generated` also records `model` and `fallback`; `accepted_by_user` is `boolean | null` because it is unknown at generation time.
- `track(type, { actorUserId, subjectType, subjectId, properties, context, occurredAt? }, dbOrTx?)` and `trackMany(batch, dbOrTx?)` in `lib/events/track.ts`. Pass the state change's transaction. `occurred_at` defaults to the clock; `subjectId` must be a UUID; properties must be JSON; `context` is strict `{ ip_country, ua_hash, session_id }`. `session_id` is an analytics session id, never the Auth.js session token.
- PII guard (`lib/events/pii.ts`): property keys containing the words email, body, token, password, passwd, secret, cookie, authorization or phone, and string values that contain an email address, make `track()` throw `EventPiiError` outside production. In production the fields are dropped or redacted and the key paths, never the values, are logged with `console.error`, so an analytics mistake never fails a business write.

### 19.7 Service adapters, jobs and observability
- **Email** (`lib/email`): `sendEmail({ to, subject, react, text?, attachments?, tags?, replyTo?, idempotencyKey? })`. Both modes render with `react-email` (`render` + `toPlainText`). The fake writes `.data/outbox/<sentAt>-<id>.json` (to, subject, html, text, attachment metadata, tags). `lib/email/outbox.ts` (`listOutbox`, `latestEmailTo`, `extractUrls`, `clearOutbox`) has no `server-only` import, so Playwright can use it. Auth.js's `sendVerificationRequest` should call `sendMagicLinkEmail({ to, url })`. Shared template parts live in `templates/_components/`, which the `pnpm email:dev` preview ignores. Tags are reduced to Resend's allowed characters. Resend errors throw `EmailSendError`.
- **Storage** (`lib/storage`): `getStorage()` in `r2.ts` returns R2 or the local fake. The interface adds `statObject(key)`: R2 has no presigned POST, and a presigned PUT cannot cap the size. So `signedPutUrl` signs only the Content-Type, and callers must `statObject` after an upload and delete anything oversize; the fake enforces `maxBytes` itself. The S3 client sets checksums to `WHEN_REQUIRED`, which R2 needs.
- **Fake storage URLs** point at `/api/dev/storage/<key>?op&exp&…&sig`. The signature is an HMAC-SHA256 under a key derived from AUTH_SECRET and covers the operation, key, expiry, and either the file name or the content type plus `maxBytes`. The route answers 404 unless storage is fake, 403 for a bad or expired signature or a content-type mismatch, and 413 over `maxBytes`. It serves files with `CSP: sandbox` and `nosniff`.
- **Storage keys** match `[A-Za-z0-9!_.*'()/-]`, are at most 512 characters, and have no empty, `.` or `..` segments. Build them with `storageKey()` and `sanitizeFilename()`.
- **Upload policy** (`lib/storage/limits.ts`, client-safe): `deliverable` 200 MB and `attachment` 25 MB (§14), plus an `image` purpose at 10 MB for product media, avatars and follower-count screenshots. SVG and HTML are not allowed for any purpose.
- **Claude** (`lib/ai/claude.ts`): `generateStructured` / `generateText` never throw. They return `AiResult`: `{ ok: true, data, … }` or `{ ok: false, fallback, reason: invalid_output | refusal | api_error, … }`, and both shapes carry `use`, `promptVersion`, `latencyMs`, `attempts` and `model`. The caller supplies `fallback`.
- **Claude retries:** only invalid output is retried, once. The SDK already retries API errors twice, and refusals are not retried.
- **Claude requests:** output uses `output_config.format` (JSON schema from the SDK's `zodOutputFormat`) and is then validated with our own Zod schema. Defaults are `max_tokens` 16000 (thinking tokens count toward it) and a 60 s timeout; `effort` is set per call. For claude-opus-5-5, claude-opus-5, claude-sonnet-5-5 and claude-fable-5-1, requests go through `client.beta.messages.create` with the server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). `deps.transport` is injectable for tests.
- **Fake Claude:** deterministic JSON generated from the Zod schema's JSON Schema, seeded by the prompt. A prompt containing `FAKE_AI_INVALID`, `FAKE_AI_REFUSAL` or `FAKE_AI_ERROR` forces that failure path. Prompt versions are `<use>@v<n>` (`definePrompt`, `lib/ai/prompts`).
- **Embeddings:** `VOYAGE_MODEL` was added to `lib/env.ts`, default `voyage-3.5` (1024-dim). Requests always send `output_dimension: 1024`. docs.voyageai.com is blocked from the build sandbox, so the Voyage 4 models could not be checked; switching later is an env change plus a re-embed. Batches are 128 texts with a 30 s timeout, responses are Zod-checked (1024 dims, sorted by index), and empty text throws. The fake is a hashed bag-of-words (FNV-1a, lowercased, stopwords dropped), L2-normalised.
- **Stripe:** `getStripe()` throws in fake mode, so callers check `isStripeFake()` first. Business code does not call it: it goes through `getStripeGateway()` (live or fake, §19.12). `STRIPE_API_VERSION = "2026-09-30.endive"` is checked with `satisfies` against the SDK's literal type, so an SDK upgrade fails typecheck until the version is bumped on purpose.
- **Social** (`lib/social/types.ts`): the §7.1 interface gained `id`, `scopes`, `supportsPkce`, and optional PKCE arguments: `authUrl(state, pkce?)` and `exchangeCode(code, pkce?)`. Google and GitHub support PKCE; Instagram and TikTok on the web do not.
- **Social data shapes:** `TokenSet` has nullable `refreshToken`, `expiresAt`, `refreshExpiresAt` and `providerAccountId`. `AudienceSnapshotInput` has `topCountries` (ISO-2 country + share; empty when unknown), `countriesBasis` (required when there are countries) and `ageGender: { basis: viewers | followers, buckets } | null`; it matches the `audience_snapshots` columns (§19.5). `SocialTokenError` signals an expired or revoked token.
- **Jobs** (`inngest/`): event names and Zod payload schemas are in `inngest/client.ts`. `defineJob({ id, event, handler, cron?: { schedule, data }, retries?, concurrency?, debounce? })` in `inngest/define.ts` builds both the Inngest function and an inline runner from one handler, which receives `{ data, step.run, runId, attempt, mode }`. Register each job in `inngest/functions/index.ts`.
- **enqueue:** `enqueue(name, data, { id? })` in `lib/jobs/enqueue.ts` validates the payload, then sends it to Inngest; when jobs are fake it runs the handlers through `after()`, or awaits them outside a request, and reports errors to Sentry. `runJobsNow` (for test routes and scripts) rethrows. Inline mode has no retries, debounce or cron.
- **Inngest details:** triggers are plain `{ event }`, and our Zod schemas validate payloads in both modes. `/api/inngest` answers 404 when jobs are fake. To use a local Inngest dev server, set INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY (any values) plus INNGEST_DEV=1.
- **Rate limits** (`lib/ratelimit.ts`): auth 10 per 10 min (per IP and per email; applied as described in §19.9), proposals 20 per day per user (§14), messages 30 per minute per user, `/r/*` 120 per minute per IP, checkout 10 per minute per IP. Keys are SHA-256-hashed before reaching Redis. If Upstash fails, the request is allowed and the error goes to Sentry. The in-memory fake is an exact sliding log on the app clock.
- **Observability:** without a DSN, Sentry is never initialised (server, edge or browser). Use `reportError(error, { tags, extra })` from `lib/observability.ts`. `onRequestError` (instrumentation.ts) passes Sentry the request path without its query string (Next hands it the raw URL, which Sentry copies into `contexts.nextjs.request_path`, outside `dataCollection`'s reach), and `beforeSend` (`scrubEvent`, sentry.shared.ts) strips it again for every SDK. PostHog initialises in `instrumentation-client.ts` (`defaults: "2026-08-30"`, `person_profiles: identified_only`, session replay off). `AnalyticsProvider` wraps the root layout so client components can use the PostHog hooks. Server code uses `captureServerEvent` (`lib/analytics/posthog-server.ts`).
- **Open item:** PostHog sets cookies. Before an EU launch we need a consent banner, or PostHog's cookieless mode (which must also be switched on in the PostHog project).

### 19.8 Navigation and layouts
- `lib/nav.ts` is the single source for every menu: `appNav(role, { includeV1 })`, `adminNav`, `marketingNav` and `LEGAL_NAV`. v1 items (`/launches`, `/app/discover/saved`, `/admin/events`, `/admin/matching`) are hidden unless `includeV1` is set. §12 has no `/app/settings` page, so "Settings" links to `/app/settings/profile` and is active for every `/app/settings/*` route. The Discover sub-items depend on the role: creators see Builders; builders see Creators and Briefs.
- The shells are presentational. `AppShell` (`components/layout`) takes `user`, `roles`, `activeRole`, `isAdmin` and the `switchRole` / `signOut` server actions. The app layout passes `toShellViewer(await requireOnboardedUser())` plus `switchActiveRole` (lib/users/actions.ts) and `signOutAction` (lib/auth/actions.ts); the admin layout uses `requireAdmin()`. `getShellViewer()` (components/layout/viewer.ts) returns the viewer for the current request, or null when signed out.
- The marketing pages read the take rate, hold days and minimum payout from env (`app/(marketing)/_lib/economics.ts`). The pages are static, so a change needs a redeploy. The €29 example uses an illustrative 21% VAT and a 1.5% + €0.25 card fee. The legal pages are outlines marked "Draft — pending legal review" (§18.2).

### 19.9 Auth & authorization
- **Database sessions** (`lib/auth/config.ts`): the cookie holds an opaque token; `sessions` maps it to a user id. Next 16's proxy runs on Node.js, so the proxy validates the session through the adapter like everything else (one query: `sessions` joined to `users`). The session callback returns `user: { id, email, name, image, roles, activeRole, status, onboardingCompletedAt }` read from that join on every request, so role changes and suspensions apply on the next request. `/api/auth/session` therefore shows users their own roles and status; nothing else. `parseAuthUser()` (`lib/auth/user.ts`) Zod-parses the payload and treats anything malformed as signed out.
- **Config per request:** `lib/auth/auth.ts` builds the config from the request, so sign-ups know their method (`/api/auth/callback/<provider>` → `user.signed_up.method`) and the optional /sign-up name. Tests inject `db` and `env`.
- **Providers:** magic link (provider id `email`, 24 h links, sent with `sendMagicLinkEmail`, so fake mode writes to the outbox), plus Google / GitHub only when both their `AUTH_*` variables are set (`configuredOAuthProviders()`; the buttons follow it). Both use `checks: ["pkce", "state"]` (§14); Auth.js defaults to PKCE only. Accounts are not linked across methods by email (`allowDangerousEmailAccountLinking` is off): signing in with Google to an email registered by magic link shows the `OAuthAccountNotLinked` message. An OAuth profile without an email is refused with `EmailRequired`.
- **Adapter changes** (`lib/auth/adapter.ts`): emails are normalised (NFKC, trimmed, lowercased) for every method; `linkAccount` drops the login providers' OAuth tokens (we never use them; §4); `createUser` is our sign-up, `registerUser()` in `lib/auth/register.ts`: one transaction that inserts the user, emits `user.signed_up`, and for `ADMIN_EMAILS` grants admin.
- **Admin grants** (`grantAdminRole`, `lib/users/roles.ts`): add the role, emit `user.role_added`, and write `admin_audit_log` (`action = "user.role_granted"`). Bootstrap grants (ADMIN_EMAILS on sign-up, `pnpm admin:grant <email>`) have no acting admin, so the audit row's `admin_user_id` is the user themselves and `after.source` says how (`admin_emails` / `admin_cli`). `user.role_added` gained a `source` property (`onboarding` | `admin_emails` | `admin_cli`). Switching the active role emits no event (§11 lists none).
- **Suspension:** the `signIn` callback refuses suspended accounts (looked up by id or email) before a magic link is sent and again on the callback, so the form shows the `AccessDenied` message. That message reveals that a suspended account exists for the address; every other case answers "check your email" whether or not the account exists. Existing sessions of a suspended user are redirected to `/sign-in?error=AccountSuspended` by the proxy and `requireUser()`. Phase 6's suspend action should also delete the user's `sessions` rows.
- **Route rules** (`lib/auth/route-guard.ts`, pure, applied by `proxy.ts`; matcher `/app/*`, `/onboarding/*`, `/admin/*`, `/sign-in`, `/sign-up`): signed out → `/sign-in?callbackUrl=<path>`; non-admins on `/admin/*` are **redirected to `/app`** (no 403 page); `/app/*` goes to `nextOnboardingStep()` first; signed-in users on `/sign-in` / `/sign-up` go to their callbackUrl or `/app`, except when the page shows an `?error=`. `safeCallbackUrl()` (`lib/auth/routes.ts`) accepts only same-origin relative paths and never `/sign-in`, `/sign-up` or `/api/*`; it checks the path again after URL parsing, because dot segments collapse (`/.//evil.example` → `//evil.example`). The proxy also resolves every redirect with `sameOriginRedirectUrl()`, which falls back to `/app` for anything off-site.
- **Defence in depth:** layouts call `requireOnboardedUser()` / `requireAdmin()`, and pages call them too, because layouts are not re-rendered on client-side navigation. `getCurrentUser()` is wrapped in React `cache`, so this costs one session lookup per render. The proxy forwards the requested path in the `x-pathname` request header so `requireUser()` can build a callbackUrl.
- **Onboarding:** the step logic and the `/app` gate are described in §19.11 (Phase 1 replaced Phase 0's "any app role enters `/app`"). `/onboarding/role` adds roles (never removes them), sets `active_role`, emits `user.role_added` per new role; existing users reach it through "Become a builder/creator" in the role switcher. Admin-only users (ADMIN_EMAILS) also pass through it before `/app`, but can open `/admin` directly.
- **Pages:** `/sign-in` is also Auth.js's error page (`?error=<code>`, plain-language messages in `SIGN_IN_ERROR_MESSAGES`) and verify-request page (`?type=email` → "check your email"). Both pages post to the `requestMagicLink` server action (Zod, then Auth.js `signIn("email", { redirect: false })`).
- **Auth rate limit (§14):** magic links are limited in the `signIn` callback when `email.verificationRequest` is set (`isAuthRateLimited`, `lib/auth/rate-limit.ts`: per IP and per email). Every magic-link request passes there, from any entry point; a refusal redirects to `/sign-in?error=RateLimited`, which the server action turns into the form message. The client IP comes from the route handler's request, or from `headers()` when a server action runs Auth.js in-process (`config(undefined)`). OAuth has no hook before the redirect to the provider, so `signInWithProvider` limits per IP itself. The `/api/auth` route answers 405 to `POST /api/auth/signin/*`: sign-in starts only from our server actions (in-process, never over HTTP), and Auth.js's HTTP endpoint would skip their validation and the OAuth limit. Callbacks, session, CSRF and sign-out stay open. The optional /sign-up name waits in an httpOnly cookie `pending_signup_name` scoped to `/api/auth` (24 h) until the callback creates the user; the auth route clears it after a successful callback. Sign-out is the `signOutAction` server action (deletes the database session) and lands on `/`. The marketing header always shows "Sign in / Get started" so marketing pages stay static; signed-in visitors who click them are sent on to `/app` by the proxy.
- **Server actions:** `defineAction({ name, input, authorize, run })` (`lib/actions/define-action.ts`) parses input (objects or FormData), calls `requireUser()`, applies `authorize`, and returns `ActionResult` (`lib/actions/result.ts`, client-safe): `{ ok: true, data }` or `{ ok: false, error, fieldErrors? }`. Throw `ActionError` for messages users should read; other errors go to Sentry with the action name and the user sees a generic message. `redirect()` / `notFound()` pass through (`unstable_rethrow`). Transactions and events stay explicit in `run`. `authorize` is required (the type requires it and `defineAction` throws without it), so no action can skip §4 step 3; actions that only touch the signed-in user's own account use `canManageOwnAccount(user)` (active user) from authz.ts.
- **Auth logging:** Auth.js's expected user-caused errors (`Verification`, `AccessDenied`, `OAuthAccountNotLinked`, `AccountNotLinked`, `MissingCSRF`) are not sent to Sentry; every other Auth.js error is.

### 19.10 Integration decisions from provider research (briefs in `docs/integrations/`)
Trifon delegated the open items to the build (2026-10-05). They are marked **(decided by delegation)**; revisit them before real money or real creator data flows.

**Social (§7.1)** (see `docs/integrations/social-providers.md`)
- **YouTube:** scopes `youtube.readonly` + `yt-analytics.readonly`; `access_type=offline`, `prompt=consent`, PKCE S256.
  - `subscriberCount` is rounded and can be hidden.
  - Demographics are *viewer* demographics (`viewerPercentage`); countries are ranked by views. Snapshot basis = `viewers`.
  - Store both `views` and `engagedViews` (in `raw`); `avg_views` uses `views`.
  - Never call `search.list`.
- **YouTube retention (decided by delegation):** Google's policy limits storing YouTube statistics to 30 days unless the platform accepts the derived-metrics policy. Env flag `YOUTUBE_LONG_RETENTION` (default `false`). While it is false, a daily job deletes YouTube-sourced `audience_snapshots` older than 30 days, using the GDPR erasure hatch. The newest snapshot and the derived profile fields (`size_tier`, `audience_summary`, `embedding`) are kept.
- **Instagram:** "Instagram API with Instagram Login", Graph API pinned to `v26.0`.
  - Scopes: `instagram_business_basic` and `instagram_business_manage_insights`.
  - No refresh token. Exchange the short-lived token for a long-lived 60-day one; `refresh()` calls `ig_refresh_token` once the token is ≥24h old.
  - Use `views`, not the deprecated metrics.
  - Demographics: `follower_demographics` (≥100 followers), basis `followers`.
- **TikTok:** scopes `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`.
  - Refresh tokens rotate; always store the new one.
  - No demographics: `ageGender = null`, `topCountries = []`.
- **GitHub (builders):** OAuth App requesting **no scope** (read-only public data), PKCE S256. One GraphQL call fetches repos, stars, languages and `contributionsCollection`. The `github` provider uses `GITHUB_DATA_CLIENT_ID`/`_SECRET` (separate from login).

**Stripe (§7.2, §9)** (see `docs/integrations/stripe.md`; SDK 23.x pins API `2026-09-30.endive`)
- **Connected accounts:** `type: 'express'` is deprecated. We create v1 accounts with controller properties: `stripe_dashboard.type = 'express'`, `fees.payer = 'application'`, `losses.payments = 'application'`, `requirement_collection = 'stripe'`, `capabilities.transfers.requested = true`, full service agreement. Onboarding uses Account Links; the Express dashboard uses `accounts.createLoginLink`.
- **`account.updated` and `capability.updated` arrive on the Connect endpoint** with their own secret, `STRIPE_CONNECT_WEBHOOK_SECRET` (added to §17's list). `/api/webhooks/stripe` verifies against both secrets. `pnpm stripe:listen` uses `--forward-to` plus `--forward-connect-to`.
- **"Payouts ready"** = `payouts_enabled` AND `capabilities.transfers === 'active'`. `stripe_accounts` stores `transfers_capability` next to the §5 booleans. "Both have payouts_enabled" in §12 means payouts-ready.
- **Checkout:** `mode: 'payment'`, `price_data` with a `tax_code` chosen per `delivery_type`, `automatic_tax`, and metadata on both the session and `payment_intent_data`.
  - Never send `payment_method_types`; it was removed in endive.
  - Fulfil only when `payment_status === 'paid'`. Delayed payment methods are fulfilled on `checkout.session.async_payment_succeeded`.
- **Ledger timing:** the Stripe fee may be unknown at `checkout.session.completed`.
  - The order, access grant and buyer email are created immediately.
  - The ledger split is posted by an idempotent `postOrderLedger(orderId)` once the balance transaction exists. It is called from `checkout.session.completed` and `charge.updated`; `orders.ledger_posted_at` marks completion.
- **Payout transfers:** one aggregated transfer per user per batch, **without** `source_transaction` (it binds a transfer to a single charge and adds nothing after the hold).
  - Idempotency key: `payout:<batchId>:<userId>`.
  - Ops requirement: set the platform's own Stripe payout schedule to manual.
- **Refunds:** handled from the `refund.created` / `refund.updated` / `refund.failed` events; `charge.refunded` is accepted too, and everything is idempotent on the refund id.
  - Stripe keeps its fee on refunds. **Decided by delegation: the platform absorbs the unreturned fee.** Member shares are reversed proportionally; the platform's loss is an `adjustment` entry.
  - If a transfer reversal fails (the connected balance is too low), the negative entries stay and are netted against future payouts.
- **§18.1 merchant of record (decided by delegation):** we build the spec default, with the platform as seller and Stripe Tax for VAT. Stripe Managed Payments (merchant of record) does not support Connect.

### 19.11 Phase 1 groundwork: schema, onboarding, notifications, test routes
Shared contracts the Phase 1 features build on. Schema changes are in migration `0005_phase1_profiles_onboarding` (generated).

**Schema**
- `users.onboarding_steps` (jsonb, default `{}`, CHECK object): step id → `{ status: "done" | "skipped", at }`. Only `completeOnboardingStep()` writes it.
- `creator_profiles.audience_summary_generated_at` and `audience_summary_edited_at`. A creator's own edit of the summary sets `edited_at`. While it is set, syncs keep the creator's summary and topics; a "Regenerate" action clears it.
- `social_connections`:
  - Display data from `SocialProfile`: `display_name`, `avatar_url`, `profile_url` (also the link an admin checks for manual rows).
  - Token data: `refresh_expires_at` (TikTok) and `token_obtained_at` (Instagram refreshes only tokens ≥24h old).
  - `last_sync_error` (a short code such as `token_expired`, `rate_limited` or `provider_error`; never a token or a response body) with `last_sync_error_at` (CHECK: both or neither). A successful sync clears them.
  - CHECK: manual rows hold no tokens.
- **Connection rules:**
  - The existing uniques stay: one connection per (user, provider), so reconnecting, or upgrading a manual row to OAuth, updates that row; and one platform user per provider account, so the callback answers `?error=account_in_use`.
  - `verified_at` is set by the OAuth callback (the API proved ownership) and by an admin for manual rows. A "verified connection" (size tier, matching) is `status = 'active' AND verified_at IS NOT NULL`.
  - Disconnecting deletes the row inside a transaction that first calls `allowGdprErasure(tx)`, so the snapshots cascade (§14), and emits `social.disconnected`.
- `stripe_accounts`:
  - `transfers_capability` is a `stripe_capability_status` enum (`active | inactive | pending | unrequested`). The default `unrequested` means absent from `account.capabilities`. Map unknown future Stripe values to `inactive` (fail closed).
  - Also `requirements_currently_due text[]` (Stripe's list includes past-due items), `disabled_reason`, and a CHECK on the `country` format.
  - `updated_from_stripe_at` is the applied event's `created` (or the retrieval time). Handlers skip events older than it.
- `stripe_events.account`: the connected account of a Connect event, else null.
- `notifications.dedupe_key`, unique per user (see `notify` below). `PG_ERROR.invalidTextRepresentation` (`22P02`, e.g. a bad enum value).

**Env**
- `STRIPE_CONNECT_WEBHOOK_SECRET` (`whsec_`): required in production.
- `stripeWebhookSecrets()` returns `{ platform, connect }`. Outside production `connect` falls back to `STRIPE_WEBHOOK_SECRET`, because fake Stripe and `stripe listen` sign Connect events with that one secret.
- `YOUTUBE_LONG_RETENTION` is a flag, default `false`.
- `pnpm stripe:listen` adds `--forward-connect-to`.

**Onboarding**
- **Files** (`lib/onboarding/`):
  - `steps.ts` (client-safe): step ids, pages, labels, the skippable set (connect, portfolio, payouts), and a tolerant `onboarding_steps` parser.
  - `next-step.ts`: pure logic over an `OnboardingSnapshot` (roles, completed_at, steps, profile flags, non-revoked creator/GitHub connection counts, portfolio count, payouts `none | pending | ready`).
  - `snapshot.ts`: loads the snapshot in one query.
  - `complete-step.ts`: `completeOnboardingStep`, `advanceOnboarding`.
  - `gate.ts`: `resolveOnboardingRedirect`.
  - `page.ts`: `requireOnboardingStep(step)` returns `{ user, snapshot, progress }` and redirects when the step is off the path or comes after an incomplete one.
  - `actions.ts`: `chooseRoles`, `skipOnboardingStep`.
  - UI: `components/onboarding/onboarding-progress.tsx` and `skip-step-button.tsx`.
- **Path:** role → creator steps (if creator) → builder steps (if builder; creators first) → payouts.
- **When a step is complete:**
  - Profile steps: the profile exists. A record does not count.
  - Connect: recorded, or ≥1 non-revoked YouTube, Instagram or TikTok connection.
  - Review: recorded `done` only; it cannot be skipped.
  - Portfolio: recorded, or ≥1 portfolio item or a GitHub connection.
  - Payouts: recorded, or payouts-ready.
  - A `done` record is never downgraded to `skipped`.
- **Gate vs navigation:**
  - The `/app` gate (proxy and `requireOnboardedUser`):
    - No app role → `/onboarding/role`.
    - `onboarding_completed_at` set → let in, with no database query.
    - Otherwise the snapshot decides.
  - `guardRoute(url, user, resolver)` is now async, with the resolver injected.
  - `nextOnboardingStep()` (navigation) ignores `completed_at`. A user who adds a role later is sent through that role's steps (`chooseRoles` redirects there). They can still open `/app` if they leave midway, so **role pages must handle a missing profile** (link to `/onboarding/<role>/profile`).
- **Finishing:** `advanceOnboarding` sets `onboarding_completed_at` once (a conditional update) and emits `onboarding.completed { roles, skipped_steps }` in the same transaction. It runs:
  - after a step is recorded;
  - after roles are added;
  - from the `/app` gate, so a path completed by facts alone (payouts became ready after the user left) finishes on the next visit. The proxy may write this once.
  - The Stripe webhook may also call it.
- **How pages record steps:**
  - Profile pages call `completeOnboardingStep(tx, { step: "<role>.profile", status: "done" })` in the transaction that inserts the profile, then `redirect(nextStep ?? "/app")`.
  - Review, connect, portfolio and payouts record `done` on Confirm / Continue / Finish.
  - "Do this later" is `SkipStepButton`.
- **E2E:** specs that are not about onboarding use `completeOnboardingInDb(email)` (`tests/e2e/helpers/db.ts`); the onboarding pages themselves are walked by `tests/e2e/onboarding.spec.ts` and `phase1-acceptance.spec.ts` (§19.15).

**Events added beyond §11**
- `onboarding.step_completed { step, status }`.
- `creator_profile.created` / `.updated` and `builder_profile.created` / `.updated`. `updated` carries `fields` (column names only) and `source` (`onboarding | settings`).
- `social.disconnected`.
- `payouts.account_created` and `payouts.account_updated` (subject type `stripe_account`, newly added). Emit `updated` only when a synced field changed.
- `ai.reviewed { use, prompt_version, accepted, edited }`: the user's decision on generated text.
- `onboarding.completed` changed from `{ role }` to `{ roles, skipped_steps }`.

**Notifications** (`lib/notifications/`)
- `types.ts` (client-safe) holds the `NotificationCatalog` (`social.expired`, `payouts.ready`; later phases extend it), `NOTIFICATION_TYPE_LABELS` and `NOTIFICATION_LINKS`.
- `notify({ userId, type, payload, email?: { subject, react }, dedupeKey? }, dbOrTx)`:
  - Reads `notification_prefs` for the type; with no row, both channels are on.
  - Inserts the in-app row with the given `dbOrTx`.
  - Sends the email immediately; a send failure goes to Sentry and never fails the caller.
  - Skips the email for users without an email address.
  - A repeated `dedupeKey` writes and sends nothing.
  - Because the email goes out even if the caller's transaction later rolls back, notify at the end of the transaction.
- Generic template: `lib/email/templates/notification.tsx` (heading, paragraphs, one button). Email links use `absoluteUrl(path)` from `lib/urls.ts`.

**Jobs and test routes**
- `POST /api/test/jobs/<job id>`, body `{ now?: ISO, data?: object }`, exists only when `testRoutesEnabled()`; every method answers 404 otherwise.
  - `data` defaults to the job's cron payload, else `{}`, and is validated against the event schema (400 when invalid).
  - The route runs `job.runInline` under `runWithClock(now)` and returns `{ ok, job, now, result }`, or 500 with the error.
  - E2E helper: `runJob(request, id, { now, data })`.
- `Job.cron` is exposed and `findJob(id)` was added to the registry.
- Job events declared ahead for Phase 1: `social/daily-sync.requested` (the daily fan-out) and `social/youtube-retention.requested`.

**Other**
- `lib/payouts/readiness.ts`: `isPayoutsReady`, `payoutsStateOf`.
- `CREATOR_SOCIAL_PROVIDERS` lives in `lib/social/types.ts`.
- `ActionError` moved to `lib/actions/errors.ts` (re-exported by `define-action.ts`), so domain modules can throw it without an import cycle through `lib/auth/session.ts`.
- Test fixtures: `insertSocialConnection`, `insertStripeAccount`, `insertPortfolioItem`.

### 19.12 Phase 1: Stripe Connect, webhooks and payouts pages
**Gateway** (`lib/stripe/`)
- `gateway.ts`: the `StripeGateway` interface (`createConnectedAccount`, `retrieveAccount`, `createAccountLink`, `createLoginLink`) and `getStripeGateway()`: live when `STRIPE_SECRET_KEY` is set, else the fake. Methods return objects parsed by `schemas.ts` (Stripe's field names, only the fields we use). Phases 4–5 add methods to the interface and to both implementations.
- `live.ts`: the SDK client from `client.ts`.
  - `accounts.create` takes `connectedAccountParams()` (`shared.ts`): the §19.10 controller properties, `capabilities.transfers.requested`, `tos_acceptance.service_agreement = full` and `metadata.user_id`. The idempotency key is `acct:<userId>`.
  - `business_type` is not prefilled: creators and builders may be companies, and Stripe's form asks.
  - Account links are `account_onboarding` with Stripe's default (`currently_due`) collection.
- `fake.ts`: Stripe-shaped JSON in `.data/fake-stripe/<object type>/<id>.json` (`account`, `account_link`, `event`), written atomically (temp file + rename).
  - Account ids are `acct_fake_` + the first 16 hex characters of sha256(idempotency key). A key therefore replays like Stripe's, and the same key with other parameters fails with `invalid_request`.
  - Account links last 5 minutes and work once; their URL is the fake onboarding page.
  - Login links need `details_submitted`, as in Stripe.
  - Tests pass `createFakeStripeGateway({ root: <temp dir>, appUrl })`.
- **Fake pages** (`fake-pages.ts`; routes under `/api/dev/fake-stripe/` that answer 404 unless Stripe is fake):
  - `connect/[accountId]?link=` offers three endings:
    - "Complete onboarding": payouts enabled, transfers active.
    - "Submit details (verification pending)": details submitted, transfers pending, `requirements.pending_verification`.
    - "Return without finishing".
  - An expired or used link redirects to `refresh_url`.
  - Completing posts a signed `account.updated` (with `previous_attributes`) to `absoluteUrl("/api/webhooks/stripe")` (the configured `NEXT_PUBLIC_APP_URL`, never the request's Host header, so a forged Host cannot receive a signed event), signed with `stripeWebhookSecrets().connect`, then redirects to `return_url`. A failed delivery is reported but still redirects; the return page re-fetches the account.
  - `dashboard/[accountId]` stands in for the Express Dashboard.
- `countries.ts` (client-safe): the payout countries are the cross-border regions: the EEA countries Stripe supports, plus GB, CH, US and CA. The country comes from a picker that defaults to the creator profile's country (builder profiles have none). It cannot change after the account exists.

**Connect** (`connect.ts`)
- **Functions:**
  - `ensureConnectedAccount`: one account per user; the row insert tolerates concurrent calls.
  - `createOnboardingLink`: creates the account first when needed.
  - `createDashboardLink`: needs `details_submitted`.
  - `refreshAccountFromStripe`.
  - `syncAccountFromStripe`: `account.updated`, or a retrieval.
  - `syncTransfersCapability`: `capability.updated`.
- **Mapping** (`stripeAccountColumns`):
  - A missing capability → `unrequested`; an unknown status → `inactive`.
  - `requirements_currently_due` = `currently_due`, deduplicated.
  - A malformed country is ignored and the stored one kept.
- **Stale data:** skipped when its whole second is older than `updated_from_stripe_at`. Events have second precision, so same-second data is applied rather than lost. `updated_from_stripe_at` only moves forward.
- **Events:**
  - `payouts.account_updated` is emitted only when a synced field changed; the actor is null because Stripe drove the change.
  - Readiness has no §11 event; `payouts.account_updated.ready` records it.
- **Becoming payouts-ready:**
  - It runs `advanceOnboarding`.
  - It notifies `payouts.ready` with dedupe key `payouts.ready:<acct>`: once per account, ever. Losing and regaining readiness does not notify again.
- **Adoption:** the webhook can beat our own insert after `accounts.create`.
  - When `account.updated` has no row but its `metadata.user_id` names a user without one, the handler creates the row (`payouts.account_created`, actor null), then applies the update.
  - Any other unknown account is acknowledged and ignored.

**Webhooks** (`webhooks.ts`; the route calls `handleStripeWebhookRequest(request, { db, secrets })`)
- **Verification:** against both secrets, with Stripe's `constructEvent` (300 s tolerance). Failures answer 400 with `missing_signature`, `invalid_signature` or `invalid_payload`.
- **Recording:** the event goes into `stripe_events` insert-if-absent, outside the handler's transaction, so a failed event keeps its payload.
- **Processing**, in one transaction:
  - Lock the row.
  - `processed_at` already set → `duplicate`.
  - Run the handler, then set `processed_at`.
  - A handler error rolls everything back and answers 500. `processed_at` stays null, so Stripe's retry reprocesses the event.
- Types without a handler are acknowledged (`ignored`) and marked processed. `processed_at IS NULL` therefore always means failed or in flight.
- **Handlers** live in `lib/stripe/handlers/`, one file per topic (`account.ts`: `account.updated`, `capability.updated`). Each exports a `StripeHandlerGroup` (event type → handler, keyed by `Stripe.Event.Type`, so a typo fails typecheck).
  - Each entry is `on(schema, handler)` (`handlers/define.ts`). The handler receives the event, with `data.object` parsed by the entry's Zod schema, and `{ tx, now }`. A payload that does not parse fails the event (500, retried).
  - `handlers/index.ts` registers the groups, one line each, and `webhooks.ts` looks types up with `stripeEventHandler(type)`. Two groups handling the same type throw when the module loads.
  - To add a type (Phases 4–5): add a schema to `schemas.ts`, a handler to a topic file (or a new `<topic>.ts`), and, for a new file, one line in `handlers/index.ts`. `handledStripeEventTypes()` lists the events to enable on the Stripe endpoints.
- Fixtures: `tests/fixtures/stripe/*.json`.
- **E2E** (`tests/e2e/payouts.spec.ts`): a builder at the payouts step (profile and portfolio set up in the database) leaves the fake onboarding, reopens the used link (refresh route → fresh link), completes it (webhook processed, onboarding finished, `payouts.ready` email), then Finish → `/app`; a creator in settings ends with verification pending and opens the fake Express Dashboard; the webhook route answers 400 to unsigned and forged requests.

**Pages**
- `/onboarding/payouts` and `/app/settings/payouts` share `components/payouts/` and `lib/stripe/page-state.ts`.
- **Status** (`payoutsStatusOf` in `lib/payouts/readiness.ts`): `not_started`, `action_required`, `verifying`, `restricted` (a `rejected.*` disabled reason) or `ready`.
- **Return:** Stripe's `return_url` is the page with `?return=1`.
  - The page re-fetches the account on return, and on every visit while it is not ready (webhooks can lag).
  - A failed re-fetch shows a notice and never breaks the page.
- **Refresh:** Stripe's `refresh_url` is `/onboarding/payouts/refresh` or `/app/settings/payouts/refresh`.
  - A GET route handler there makes a new link for the user's existing account and redirects (303). It never creates an account.
  - On failure it goes back to the page with `?error=link`.
- **Actions** (`lib/stripe/actions.ts`, authorized with `canManageOwnAccount`): `startPayoutsOnboarding({ from, country? })`, `openStripeDashboard` and `finishPayoutsStep`.
- **Finishing the step:** "Finish" / "Continue" records `payouts` as `done` when payouts are ready, **or** when Stripe is verifying everything the user submitted (they have done their part). Readiness is still checked when signing.
  - In every other state the page offers only "Do this later".
- Settings pages share tabs (`app/app/settings/layout.tsx`, §19.15).

**Open items**
- **GDPR (Phase 6):** `stripe_events.payload` of `account.*` events holds the connected account's email and business profile, so account deletion must redact it.
- Payouts actions have no rate limit. Each click makes one or two Stripe API calls on the user's own account.

### 19.13 Phase 1: social providers library (`lib/social/`)
**Files:** `types.ts` (contracts, §19.7), `catalog.ts` (labels; who may connect what: YouTube, Instagram, TikTok → creator; GitHub → builder or creator; `canConnectProvider`), `errors.ts`, `http.ts`, `metrics.ts`, `topics.ts`, `raw.ts`, `tokens.ts`, `pkce.ts`, `oauth-cookie.ts`, `registry.ts`, `youtube.ts` / `instagram.ts` / `tiktok.ts` / `github.ts`, `fake/`. Get a provider only through `getProvider(id, { fetch?, now? })`.

**Errors**
- `SocialTokenError`: the token is expired or revoked (401, `invalid_grant`, Graph code 190, TikTok `access_token_invalid`, an Instagram token past its expiry, a TikTok refresh token past `refreshExpiresAt`).
- `SocialRetryableError` (`reason`: `rate_limited` | `unavailable`, plus `retryAfterSeconds`): 429, Google quota reasons, Graph codes 4/17/32/613, GitHub 403 with `x-ratelimit-remaining: 0` or a "rate limit" message, GraphQL `RATE_LIMITED`; 408/425/5xx, network errors and timeouts.
- `SocialProviderError` with a `code`: `invalid_response` (Zod), `invalid_code`, `no_channel`, `scope_missing`, `not_eligible`, `provider_error`.
- Our own configuration errors (`invalid_client`, `unauthorized_client`, `incorrect_client_credentials`, TikTok `invalid_request`, Instagram OAuth code 101) are `provider_error`, never token errors, so a misconfigured app cannot expire users' connections. A rejected grant during the code exchange is `invalid_code`.
- `socialErrorCode(error)` gives the short code for `last_sync_error` and the callback's `?error=`; `socialErrorMessage(code, label)` the plain-language text.
- Error messages hold the provider, an endpoint label and the HTTP status only: never URLs (Instagram sends the token in the query string), bodies, or Zod issue messages (paths and codes only).

**Transport:** every HTTP call goes through an injectable `SocialFetch` (`ProviderConfig.fetch`). Live: `fetch` with a 20 s timeout and `cache: "no-store"`. Fake: `createFakeSocialFetch(provider)`. Tests wrap either.

**Mapping decisions beyond §19.10**
- **YouTube:** one uploads page (25) → one `videos.list` (≤ 50 ids). Upcoming/live broadcasts are skipped, and so are videos under 3 days old when older ones exist (still gathering views). `avg_views` and engagement use ≤ 20 settled videos; engagement = (likes + comments) ÷ views, hidden likes or disabled comments count as 0. Analytics covers the 90 days ending yesterday (UTC): totals, top 10 countries by views, ageGroup × gender. Country shares are of the window's total views; `ZZ` is dropped. An Analytics 403 or an unticked analytics scope keeps the Data API numbers (`raw.analytics.available = false`). `age18-24` → `18-24`, `age65-` → `65+`. A refresh response without `refresh_token` keeps the stored one; `refresh_token_expires_in` (apps in Testing status) fills `refreshExpiresAt`.
- **Instagram:** the connection's identity is the professional account id (`/me` `user_id`), which the media and insights edges also take. `TokenSet.providerAccountId` stays null, because the token's `user_id` is documented as the app-scoped id. `PERSONAL` accounts → `not_eligible`. The last 12 posts (no stories or ads) get insights, 4 requests at a time; a failing post insight (e.g. #100) is tolerated and counted in `raw.insights.failedMedia`. Engagement = (likes + comments + shares) ÷ views over posts with views. Demographics: `follower_demographics` by `country` and by `age,gender`, normalised to shares; country shares divide by max(listed total, followers) because only the top 45 are listed; top 10 kept. Below 100 followers or without the insights scope no demographics are requested (`raw.demographics.reason`).
- **TikTok:** user fields are requested per granted scope and `video.list` only when granted; missing scopes are listed in `raw.missingScopes`. Engagement = (likes + comments + shares) ÷ views over ≤ 20 videos. Token errors can arrive with HTTP 200, so the body is checked first.
- **GitHub (builders):** `followers` = GitHub followers; `top_topics` = the top 8 languages by bytes, lowercase; `avg_views`, engagement and demographics are null/empty. Everything else is in `raw` (`githubRawSchema`): public repo count, total stars and forks (owned, public, non-fork; first 100 repos by stars), top languages with bytes and share, top 10 repos, and the last 365 days of `contributionsCollection` counts (private contributions only as a count). **Typed accessor:** `gitHubStatsFromRaw(snapshot.raw)` (null for anything else). Classic OAuth App tokens never expire; `refresh()` is a no-op unless the app opted into expiring tokens.
- `top_topics` is a deterministic best effort (`deriveTopics`): hashtags and tags count double, title words once; with ≥ 3 items a term must recur; stopwords and platform words dropped; ≤ 8. The curated topics come from the AI summary.
- `raw` shapes are versioned Zod schemas (`raw.ts`, `v: 1`) used both to write and to read (`parseSnapshotRaw`, `recentContentTitles`). They hold public titles/captions, never tokens or viewer data.

**Token timing:** `tokenNeedsRefresh(provider, token, now)` is the one rule: refresh within 5 minutes of expiry; Instagram also once the token is ≥ 24 h old (from `obtainedAt`, else estimated as `expiresAt` − 60 days); never for tokens without expiry. `refresh()` re-checks: Instagram returns the token unchanged when it is younger than 24 h, TikTok refuses a refresh token past `refreshExpiresAt` without calling TikTok. `TokenSet.obtainedAt` maps to `social_connections.token_obtained_at`.

**OAuth state cookie** (`oauth-cookie.ts`)
- `beginOAuthState({ provider, userId, returnTo, usePkce })` → `{ state, pkce, cookie }` (set with `response.cookies.set(name, value, options)`). `verifyOAuthState({ provider, userId, cookieValue, state })` → `{ ok: true, codeVerifier, returnTo }` or `{ ok: false, reason, returnTo }` with reason `missing | invalid | expired | state_mismatch | user_mismatch | provider_mismatch`. `clearedOAuthStateCookie(provider)` for every callback response.
- Cookie `oauth_state_<provider>`, path `/api/oauth/<provider>` (start and callback both see it), httpOnly, SameSite=Lax, Secure on https, 10 minutes, AES-GCM (`lib/crypto`) with the provider as AAD. `returnTo` goes through `safeCallbackUrl` (default `/app/settings/connections`). State and user id are compared timing-safely (SHA-256, then `timingSafeEqual`).

**Fakes** (§19.3)
- Same provider code: the registry swaps the authorize URL for `/api/dev/fake-oauth/<provider>/authorize` and the transport for `fake/transport.ts`.
- Fixtures `tests/fixtures/social/<provider>/<account>.json`: label, description, `oauth` reply templates (`token`, Instagram `longLived`, `refresh`; `{{access_token}}` / `{{refresh_token}}` placeholders, lifetimes from their `expires_in` fields; a non-2xx `status` records a failure) and recorded API `responses` matched by method, URL and a subset of query parameters (most specific wins). Accounts: YouTube `ada-codes` (full analytics; an upcoming premiere, hidden likes, comments off), `quiet-kitchen` (hidden subscriber count, analytics without rows), `lapsed-lens` (refresh → `invalid_grant`; no demographic rows); Instagram `luna-bakes` (demographics; one failing insight), `tiny-studio` (64 followers, no demographics; flat token reply); TikTok `max-moves` (all scopes), `fresh-start` (profile/stats scopes unticked, no videos); GitHub `octo-builder`, `new-dev` (no repos).
- Codes and tokens are self-contained HMAC-signed values (`fake/signing.ts`, key derived from `AUTH_SECRET`) that carry the provider, fixture account, issue and expiry times, and for codes the PKCE challenge and redirect URI: no fake state in memory or on disk. The fake token endpoint checks client credentials, grant type, provider, expiry (codes 10 minutes, on the app clock), the exact `redirect_uri` and PKCE S256. API calls need an unexpired fake access token, so a mocked clock exercises refreshes. Failures use each provider's real error shapes.
- The consent page lists the fixture accounts ("Authorize as <label>") and validates the client id, `response_type=code` (GitHub's authorize endpoint takes none), the state, an S256 challenge and an exact `redirect_uri` match (a mismatch is refused on the page, never redirected to). "Cancel" returns `error=access_denied`. Instagram's redirect gets its `#_` suffix. The CSP `form-action` names the app origin, because browsers apply it to the redirect after the post. Every method answers 404 unless that provider is fake (`isProviderFakeSafe`, always false in production).

**Audience summary** (`lib/ai/prompts/audience-summary.ts`): `audience_summary@v1` → `{ summary, topics }` (3–5 sentences, ≤ 1200 characters; ≤ 8 lowercase topics). `generateAudienceSummary(input, deps)` never throws (`effort: "low"`); `normalizeAudienceSummary` lowercases and de-duplicates topics and collapses whitespace; an empty summary counts as `invalid_output` with the empty fallback, and the caller keeps the old summary. `hasAudienceData()` lets the sync skip the call. Input: the profile's niche, topics, languages and country, plus per-connection aggregates with their basis and ≤ 10 recent titles; no names, handles, emails or tokens. Titles sit inside `<untrusted_content>` (angle brackets stripped) and the system prompt forbids following instructions there. Unverified manual entries are labelled as such.

**Connection flow:** `/api/oauth/[provider]/start` and `/callback`, `lib/social/sync.ts` and the sync jobs are built (§19.14). The callback takes the identity from `fetchProfile().providerAccountId` and its `?error=` from `socialErrorCode()`.

**Tests:** `tests/unit/social/` (each provider against its fixtures, malformed responses, error classes, refresh rules, cookie and PKCE including the RFC 7636 vector, the fake page), `tests/integration/social/fixture-snapshots.test.ts` (every fixture's snapshot stored in Postgres and read back), `tests/e2e/social-fake-oauth.spec.ts` (the consent page in a browser).

### 19.14 Phase 1: social connection flow, sync, audience pages and public profiles
**Files**
- `lib/social/`: `oauth-flow.ts` (the start/callback logic; the routes under `app/api/oauth/[provider]/` only pass the session user and the database), `connect-errors.ts` (`?error=` codes and messages), `connections.ts` (token columns, OAuth upsert, disconnect), `sync.ts`, `derived.ts` (size tier, audience summary, embedding), `size-tier.ts`, `retention.ts`, `manual.ts` + `manual-policy.ts`, `revoke.ts`, `summary.ts` + `summary-form.ts` (the creator's review/edits), `queries.ts` (never selects token columns), `view.ts` / `audience.ts` (page view models), `authz.ts`, `actions.ts`, `background.ts`, `revalidate.ts`.
- `lib/public-profiles/` (`load.ts`, `metadata.ts`); jobs `inngest/functions/social-sync.ts`, `social-daily-sync.ts`, `social-youtube-retention.ts`; email `lib/email/templates/social-expired.tsx`; UI in `components/social/`, `components/audience/`, `components/public-profile/`.
- Pages: `/onboarding/creator/connect`, `/onboarding/creator/review`, `/app/audience`, `/app/settings/connections`, `/c/[handle]`, `/b/[handle]`.

**Authorization:** the social rules (`canConnectSocial`, `canManageSocialConnection`, `canVerifySocialConnection`, `canViewOwnAudience`) live in `lib/social/authz.ts`, built on `isActive` / `isAdmin` from `lib/auth/authz.ts`. Deviation from §6's single file, made to keep the shared file untouched during the parallel build; they can move into `authz.ts` later.

**OAuth flow**
- Start: needs a session (signed out → `/sign-in?callbackUrl=<returnTo>`, since an `/api` path is never a callbackUrl), the provider allowed for the user's roles, and the rate limit `oauth-start` (10 per user per 10 minutes). Every redirect is a 303 to `absoluteUrl()` (NEXT_PUBLIC_APP_URL).
- Callback answers: `returnTo?connected=<provider>` or `returnTo?error=<code>&provider=<provider>`.
  - Codes: the `SocialErrorCode`s, plus `access_denied` (Cancel on the consent screen), `state_invalid` (cookie missing, tampered with, other state, other user), `session_expired` (more than 10 minutes), `account_in_use` and `not_allowed`.
  - Without a readable cookie the return path is unknown, so it goes to `/app/settings/connections`.
  - The state cookie is cleared on every callback answer.
  - Expected user-side failures (`invalid_code`, `no_channel`, `scope_missing`, `not_eligible`, `rate_limited`) are not sent to Sentry; everything else is.
- Identity is `fetchProfile().providerAccountId`. A reconnect, or a manual entry upgraded to OAuth, updates the existing row: active, `verified_at = now`, sync error cleared, evidence key cleared (the screenshot is deleted, best effort). If the row now points at a different provider account (another channel), its old snapshots are deleted under `allowGdprErasure` and `last_synced_at` is reset. `social.connected` is emitted on every successful callback, reconnects included.
- Tokens: AES-GCM (`lib/crypto.ts`) with the AAD `social_connections.<access|refresh>_token:<row id>`, so a ciphertext only decrypts on its own row. Tokens that cannot be decrypted (e.g. a rotated key) are treated as expired.
- After the upsert the callback enqueues `social/sync.requested` (`reason: connected`); an enqueue failure is reported, and the daily sync picks the connection up.

**Sync** (`syncConnection(connectionId, { db, now, provider, ai, embed })`)
- Order: refresh when `tokenNeedsRefresh` (the new tokens are stored at once, before anything else can fail), then `fetchProfile` (refreshes username, display name, avatar and profile link; one cheap call) and `fetchAudience` (parsed again with `audienceSnapshotInputSchema`).
- One transaction: the snapshot, the connection update (`last_synced_at`, sync error cleared), the size tier and `social.synced`. The summary and embedding come after it, outside any transaction (no model call inside a transaction). GitHub syncs skip the summary and embedding.
- `SocialTokenError` marks the connection expired, with reason `refresh_failed` during the refresh, else `unauthorized`:
  - `active → expired` is a conditional update, so this happens once;
  - `social.expired` and a size tier recompute (an expired connection is no longer verified);
  - `notify("social.expired")`: in-app plus email (`social-expired.tsx`), dedupe key `social.expired:<id>:<token_obtained_at ms>`.
- Retryable errors record `last_sync_error` and come back `retryable`; the job throws *inside* its step so Inngest retries it (a step that returned is memoised and would never run again). Other provider errors record the code, go to Sentry and are final. Anything that is not a provider error (database, bug) propagates.
- Results: `synced | skipped (not_found, revoked, expired, manual) | expired | failed`.

**Jobs**
- `social-sync` (`social/sync.requested`): 3 retries, concurrency 1 per `connectionId`.
- `social-daily-sync` (cron 04:15 UTC): active OAuth connections not synced in the last 20 hours. Under Inngest one event each, with the idempotency id `social-sync:<id>:<day>`. Inline (fake jobs, `/api/test/jobs/social-daily-sync`) the syncs run in sequence and it returns `{ due, failed }`.
- `social-youtube-retention` (cron 03:45 UTC): `purgeExpiredYouTubeSnapshots()` deletes YouTube snapshots older than 30 days except each connection's newest; other providers are untouched; `{ skipped: true }` when `YOUTUBE_LONG_RETENTION=true`.
- Open item: Google's other rule (delete within 30 days once a token can no longer be refreshed) is not implemented for expired YouTube connections; decide together with the retention flag.

**Size tier:** the largest single platform's followers, not the sum (audiences overlap). Verified connections (active and `verified_at` set) are preferred; otherwise other non-revoked creator connections (unverified manual entries, expired ones), and the tier shows as "Unverified". Boundaries: < 10K nano, < 100K micro, ≤ 500K mid, > 500K macro. GitHub never counts. It is recomputed inside the transaction of every snapshot, expiry, disconnect, manual entry and verification.

**Audience summary and topics**
- The sync writes `creator_profiles.audience_summary` **and `topics`** (the AI topics) unless `audience_summary_edited_at` is set. Profile forms that edit `topics` should set `audience_summary_edited_at` too, or the next sync overwrites them.
- No audience data → no model call. A failed generation keeps the old summary. An edit saved while the model runs wins (conditional update).
- "Regenerate" (5 per user per hour) forces a new summary and clears `audience_summary_edited_at`.
- Events:
  - `ai.generated` at generation: subject `creator_profile`, actor null for syncs, `accepted_by_user: null`, `fallback`.
  - `ai.reviewed` when the creator confirms the AI text (`accepted`) or changes it (`edited`), on the review page or `/app/audience`.
  - `creator_profile.updated { fields, source }` for edits, which also set `audience_summary_edited_at`.
- On `/onboarding/creator/review`, "Continue" saves the summary and topics, emits those events and records `creator.review` done, all in one transaction.

**Embedding:** `creatorProfileEmbeddingText()` (niche, topics, bio, audience summary, languages, country; no names or handles), with `embedding_model` `fake:hashed-bow-1024` or `voyage:<VOYAGE_MODEL>`. An embedding failure is reported and keeps the old vector. Phase 2's `embeddings/refresh` should reuse the same text builder.

**Manual entry fallback**
- Form: profile link (https, on the provider's domain; it is what the admin checks), follower count, screenshot.
- Upload: a signed PUT (10 minutes) to the key `social-evidence/<userId>/<provider>-<uuid>.<ext>`.
  - The policy is the image MIME allow-list with a **25 MB** limit (the attachment limit, as the task asked; §19.7 lists screenshots under the 10 MB `image` purpose).
  - The submit checks that the key is under the user's own prefix, then `statObject`s it (type and size); a refused object is deleted.
- Refused while an OAuth row exists for the provider (resync or reconnect instead).
- Storing it:
  - A new entry: a `manual` row (no tokens, `verified_at` null) and a snapshot holding only the followers (`raw = { source: "manual", v: 1 }`).
  - Events: `social.connected` (source `manual`) on the first entry, `social.synced` on every entry.
  - Re-entering updates the row and resets `verified_at`.
- Shown as "Unverified" on the connection cards, `/app/audience`, the review page and the public profile.
- Admin verification:
  - `verifyManualConnection(db, admin, id)` and the server action `verifySocialConnection` set `verified_at`, write `admin_audit_log` (`social_connection.verified`) and recompute the tier, in one transaction. Idempotent.
  - `evidenceViewUrl()` gives the admin a 5-minute screenshot link.
  - The admin UI is Phase 6.

**Disconnect**
- After a confirmation dialog, the row is deleted under `allowGdprErasure` (snapshots cascade, tokens gone), with `social.disconnected` and the size tier in the same transaction.
- After the commit, best effort:
  - Token revocation: Google `/revoke` with the refresh token; GitHub `DELETE /applications/{client_id}/grant`; TikTok `/v2/oauth/revoke/`. Instagram has no endpoint. Fakes are skipped.
  - The evidence screenshot is deleted.
  - The summary and embedding are refreshed. When nothing remains to summarise, the existing summary is kept.

**Rate limits:** `oauth-start` 10 per 10 minutes per user; `social-resync` 3 per 15 minutes per connection; `social-evidence-upload` 10 per hour per user; `audience-summary-regenerate` 5 per hour per user.

**Pages and background work**
- `runInBackground` uses `after()` inside a request and runs inline elsewhere. Resync enqueues the job.
- Pages poll (`SyncRefresher`: `router.refresh()` every 2.5 s, at most 24 times) while:
  - a connection made less than 2 minutes ago has no snapshot yet, or
  - new data arrived less than 2 minutes ago and its summary is still being written.
- Older pending states are shown as they are, so a lost job never blocks a page.
- `/app/audience`:
  - Non-creators see "Become a creator"; creators without a profile get a link to the profile step (§19.11).
  - Demographics are shown per platform with their basis (YouTube: viewers over the last 90 days; Instagram: followers). Gender groups are female, male and "other or unspecified" (YouTube's user_specified and Instagram's U together).
  - Charts are ranked bar tables, and stacked age bars with a legend carrying totals and a table view. Colors come from the dataviz reference palette (blue, orange, aqua), checked for color-vision deficiency in both themes against the card surface.
- `ConnectButton` / `connectHref(provider, returnTo)` (`components/social/connect-button.tsx`) is the link every Connect button uses, e.g. GitHub on `/onboarding/builder/portfolio`.

**Public profiles** (`lib/public-profiles/load.ts`)
- Each loader selects only the public fields listed in its header:
  - Creator: handle, name, bio, niche, topics, languages, country, size tier, and whether the tier rests on verified numbers.
  - The audience summary, and per platform: followers, average views, engagement, verified or unverified, and the date.
  - The channel link only for verified connections. Verified reach is the sum of the verified platforms.
  - Builder: skills, stack, availability, deal preference, portfolio, and GitHub stats.
- No emails, ids, tokens, raw payloads, demographic breakdowns or screenshots. Only http(s) URLs reach an `href`.
- Unknown, invalid or suspended → 404. Uppercase handles redirect (308) to lowercase.
- ISR: `revalidate = 300` and an empty `generateStaticParams`, plus a best-effort `revalidatePath` after syncs, expiries, disconnects and summary changes. A 404 can stay cached for up to 5 minutes.
- Metadata: title, description (bio, else summary, else a default; ≤ 160 characters), canonical URL, Open Graph `profile`, Twitter `summary`. No OG image.

**Tests**
- Integration (`tests/integration/social/`):
  - `connection-flow.test.ts`: start and callback, the state cookie, wrong state or user, expiry, cancel, reconnect, `account_in_use`, manual → OAuth upgrade, disconnect.
  - `sync.test.ts`: snapshot, summary, tier, embedding and events; edited summary kept; model fallback; token refresh; expiry with notification and email; retryable errors; GitHub; jobs; retention and its flag; manual entry and admin verification; review events.
  - `public-profiles.test.ts`.
- Unit: `tests/unit/social/connection-pure.test.ts`.
- E2E: `tests/e2e/phase1-acceptance.spec.ts`. Every step goes through the pages and the fakes, the profile forms included (only the manual-entry test sets its profile up in the database).

### 19.15 Phase 1: profiles, onboarding pages and settings
**Files**
- `lib/profiles/`:
  - Client-safe: `handle-format.ts` (the handle pattern; `lib/db/schema/columns.ts` re-exports it), `locale.ts` (country and language lists, English names via `Intl.DisplayNames`), `fields.ts` (limits, labels, Zod form schemas).
  - Server: `handles.ts`, `save.ts`, `portfolio.ts`, `queries.ts`, `page-data.ts`, `embedding.ts`, `actions.ts`.
- `lib/users/account.ts` + `account-actions.ts`; `lib/notifications/prefs.ts` + `actions.ts`.
- Pages: `/onboarding/creator/profile`, `/onboarding/builder/profile`, `/onboarding/builder/portfolio`, `/app/settings/profile`, `/app/settings/notifications`, `/app/settings/account`, and `app/app/settings/layout.tsx`.
- UI: `components/profiles/`, `components/settings/`, `components/layout/settings-nav.tsx`, `components/onboarding/continue-step-button.tsx`.
- Rules in `lib/auth/authz.ts`: `canEditCreatorProfile`, `canEditBuilderProfile` (the role and an active account) and `canManagePortfolioItem` (the owner only; admins included, they get admin tools in Phase 6). `finishConnectStep` now authorizes with `canEditCreatorProfile` instead of `canManageOwnAccount`.

**Saving a profile**
- One action per form: `saveCreatorProfileAction` / `saveBuilderProfileAction`, with input `from: onboarding | settings`. It creates or updates the profile in one transaction:
  - claim the handle;
  - insert or update the profile;
  - release the old handle;
  - emit `<role>_profile.created`, or `.updated { fields, source }` with changed column names only;
  - `completeOnboardingStep(<role>.profile, done)` (idempotent).
- From onboarding it redirects to the next step. From settings it returns, and the form shows "Saved.".
- **Creator form:** display name, handle, niche, bio, country, languages.
  - Topics are not on it. The audience summary writes them, and the creator edits them next to the summary (review step, `/app/audience`).
  - Editing topics sets `audience_summary_edited_at` (§19.14). On the profile step, that would stop the first sync from ever writing a summary.
- **Builder form:** display name, handle, bio, skills, stack, availability (default `open`), deal preference (default `either`).
  - Skills and stack are comma lists: ≤ 12 items of ≤ 40 characters, duplicates dropped ignoring case, the first spelling kept.
- **Limits:** names 60 characters, bio 500, niche 80, ≤ 6 languages.
- **Country:** optional, any ISO 3166-1 alpha-2 code (plus XK). It preselects the payout country (§19.12).
- **Languages:** 49 ISO 639-1 codes (common creator languages plus the EU languages), stored lowercase in list order and shown by English name on public profiles. Twelve are shown up front, the rest under "More languages".
- **After the commit, in the background:**
  - `runInBackground` moved to `lib/jobs/background.ts` and takes an `area` tag; `lib/social/background.ts` wraps it.
  - The creator embedding (lib/social/derived.ts) is refreshed when niche, bio, languages or country changed.
  - The builder embedding (`builderProfileEmbeddingText`: skills, stack, bio, portfolio items; no names) is refreshed when bio, skills, stack or the portfolio changed. Phase 2's `embeddings/refresh` should reuse both text builders.
  - Public profiles are revalidated, and after a rename the old handle's paths too.

**Handles**
- **Input:** typed with or without `@`, in any case, and stored lowercase.
- **Reserved:** `RESERVED_HANDLES` (admin, support, staff, official, vincera, …), so no profile can pose as the platform.
- **Claiming:** `claimHandle` inserts into `handles` with `ON CONFLICT DO NOTHING`. A handle owned by someone else throws `HandleTakenError`.
  - `HandleTakenError` is an `ActionError` carrying `fieldErrors.handle`.
  - `ActionError` gained optional `fieldErrors`, which `defineAction` returns.
- **Sharing:** a new profile starts from the user's other profile (handle, name, bio), so one handle can serve both `/c/` and `/b/`.
- **Renaming:**
  - Changing one profile's handle claims the new one.
  - The old `handles` row is deleted only when neither profile still uses it.
  - Renames are allowed at any time. Old public URLs answer 404; no redirects are kept.
- **Suggestions:** without another profile, `suggestHandle` derives a handle from the name or email (accents stripped) and adds a numeric suffix when that one is taken or reserved.

**Portfolio**
- **Fields:**
  - Title: ≤ 80 characters.
  - Link: http(s) only, `https://` added when missing, ≤ 500.
  - Description: ≤ 300.
  - Format: optional, `product_format`.
  - Shipped: a checkbox.
- At most 12 items per builder.
- `image_url` is not collected yet: there is no upload flow for portfolio images, and public pages show none.
- **Events:** changes emit `builder_profile.updated { fields: ["portfolio_items"], source }`. §11 has no portfolio event, and for matching it is the builder profile that changed.
- **Onboarding:** "Continue" (`finishPortfolioStep`) needs ≥ 1 item or a GitHub connection, like the connect step; otherwise the page offers "Do this later".

**Other pages**
- **Role page:** roles the user already has are marked and disabled. A user with both roles sees a link to `/app` instead of the form.
- **`/app` home:**
  - Cards come from the real state: connections, portfolio, payouts.
  - A role without a profile shows "Set up your <role> profile" (§19.11).
- **Settings:**
  - Every settings page has the tabs from `SETTINGS_NAV` (lib/nav.ts, also the sidebar's children): Profile, Connections, Payouts, Notifications, Account.
  - **Profile:** the user's profiles, active role first, plus the portfolio for builders. A missing profile links to its onboarding step.
  - **Notifications:** email and in-app switches per `NOTIFICATION_TYPES` entry, upserted into `notification_prefs`. Built ahead of Phase 3 because the sidebar links to it and `notify()` already reads the switches.
  - **Account:**
    - Name (`users.name`).
    - Sign-in email, read-only: changing it needs a verification flow that is not built.
    - Roles: the missing one can be added through `/onboarding/role`.
    - Session count, and "Sign out everywhere", which deletes every `sessions` row and then signs this browser out.
    - Data export and deletion are described as coming (§14, Phase 6). There are no dead buttons.

**Forms:** `components/profiles/form-kit.tsx`
- `useFormAction` keeps the submitted values when an action fails. React resets uncontrolled fields after every form action, so without it a typo would wipe the form.
- Also `Field`, `describe()` (`aria-describedby` / `aria-invalid`), `NativeSelect` and `RadioCard`.
- Forms submit with `noValidate`, so the server's plain-language messages show.

**Tests**
- **Unit:** `tests/unit/profiles/fields.test.ts`, plus the new rules in `tests/unit/auth/authz.test.ts`.
- **Integration:** `tests/integration/profiles/profiles.test.ts`:
  - handles, saves and events;
  - portfolio ownership and limits, and the builder embedding;
  - the actions, with a mocked session and `next/cache`;
  - account settings and notification preferences.
- **E2E:** `tests/e2e/onboarding.spec.ts`:
  - a creator, a builder, and a user with both roles;
  - validation errors that keep the typed values;
  - settings tabs, a handle rename and its public page, notification switches, sign out everywhere.
- `phase1-acceptance.spec.ts` now fills the profile forms.
- **Test helpers:**
  - `stubServiceEnv()` also blanks the social credentials (`GOOGLE_YT_*`, `META_*`, `TIKTOK_*`, `GITHUB_DATA_*`).
  - Playwright's `expect.timeout` is 15 s under `next dev`, where a first request compiles the route and a server action's redirect took over 5 s. It stays at 5 s for CI's build and start.

**Phase 1 gate (W1)**
- `app/icon.svg` (the logo mark, light and dark) was added. Without an icon, every page's request for `/favicon.ico` was a 404 in the browser console.
- A walk on `pnpm dev` with `FAKE_SERVICES=all`, scripted with Playwright, covers the §16 Phase 1 criteria:
  - a creator connects YouTube and sees `/app/audience` with fixture data;
  - a builder connects GitHub and adds a project;
  - both finish fake Stripe Connect: the webhook is delivered and processed, `stripe_accounts` shows payouts enabled with transfers active, and Settings → Payouts says "Payouts are ready";
  - `/c/<handle>` and `/b/<handle>` render.
- The same walk checked at 390 px wide in dark mode (no horizontal scroll), that tokens are stored encrypted, and that the §11 events exist without emails or tokens in their properties.
