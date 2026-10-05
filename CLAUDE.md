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
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
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

### 19.2 Library realities
- **Auth.js:** the stable `next-auth` release is v4. App Router support is v5, which is published only as `next-auth@beta`. We use v5 beta with `@auth/drizzle-adapter`. All auth code is contained in `lib/auth/`.
- **Drizzle:** we use the latest stable 0.x release. 1.0 is still an RC.

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

### 19.4 Testing
- Integration tests run against real Postgres + pgvector. Each test run clones a freshly migrated template database, so parallel runs don't collide. Locally, set `TEST_DATABASE_URL`. CI uses a `pgvector/pgvector` service container.
- E2E runs `next build && next start` (or `next dev` locally) against a dedicated e2e database that is reset, migrated and seeded before the run, with `FAKE_SERVICES=all`.
- Test-only routes under `/api/test/*` (run a job with a mocked clock, read the outbox) exist only when `E2E_TEST_ROUTES=1` **and** `NODE_ENV !== 'production'`.
- Time: business logic takes `now` from `lib/clock.ts`, never from `new Date()` directly, so jobs can run with a mocked clock.
