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
- Migrations: `0000` enables pgvector (custom), `0001` is the generated schema, `0002` adds the append-only triggers (custom), `0003` seeds matching v0 (custom), `0004` adds `audience_snapshots.countries_basis` (generated), `0005` adds the Phase 1 columns (generated, §19.11), `0006` adds `notifications.in_app` (generated), `0007` enables row-level security on every table (generated), `0008` revokes Supabase's Data API roles (custom; §19.18) and `0009` adds the Phase 2–3 columns, indexes and checks (generated, §19.24).
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
- **Observability:** without a DSN, Sentry is never initialised (server, edge or browser). Use `reportError(error, { tags, extra })` from `lib/observability.ts`; it redacts database errors first (`redactDbError`, §19.18). `onRequestError` (instrumentation.ts) passes Sentry the request path without its query string (Next hands it the raw URL, which Sentry copies into `contexts.nextjs.request_path`, outside `dataCollection`'s reach), and `beforeSend` (`scrubEvent`, sentry.shared.ts) strips it again for every SDK. PostHog initialises in `instrumentation-client.ts` (`defaults: "2026-08-30"`, `person_profiles: identified_only`, session replay off). `AnalyticsProvider` wraps the root layout so client components can use the PostHog hooks. Server code uses `captureServerEvent` (`lib/analytics/posthog-server.ts`).
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
- **E2E:** specs that are not about onboarding use `completeOnboardingInDb(email)` (`tests/e2e/helpers/db.ts`); the onboarding pages themselves are walked by `tests/e2e/onboarding-profiles.spec.ts` and `phase1-acceptance.spec.ts` (§19.15, §19.17).

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
  - A repeated `dedupeKey` writes and sends nothing. The key is claimed even when in-app is off for the type: a hidden row (`in_app = false`) records the delivery, so the email still goes out once (§19.18). In-app lists and unread counts must filter `in_app = true`.
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
- `lib/social/`: `oauth-flow.ts` (the start/callback logic; the routes under `app/api/oauth/[provider]/` only pass the session user and the database), `connect-errors.ts` (`?error=` codes and messages), `availability.ts` (`SOCIAL_OAUTH_DISABLED`, below), `connections.ts` (token columns, OAuth upsert, disconnect), `sync.ts`, `derived.ts` (size tier, audience summary, embedding), `size-tier.ts`, `retention.ts`, `manual.ts` + `manual-policy.ts`, `revoke.ts`, `summary.ts` + `summary-form.ts` (the creator's review/edits), `queries.ts` (never selects token columns), `view.ts` / `audience.ts` (page view models), `authz.ts`, `actions.ts`, `background.ts`, `revalidate.ts`.
- `lib/public-profiles/` (`load.ts`, `metadata.ts`); jobs `inngest/functions/social-sync.ts`, `social-daily-sync.ts`, `social-youtube-retention.ts`; email `lib/email/templates/social-expired.tsx`; UI in `components/social/`, `components/audience/`, `components/public-profile/`.
- Pages: `/onboarding/creator/connect`, `/onboarding/creator/review`, `/app/audience`, `/app/settings/connections`, `/c/[handle]`, `/b/[handle]`.

**Authorization:** the social rules (`canConnectSocial`, `canManageSocialConnection`, `canVerifySocialConnection`, `canViewOwnAudience`) live in `lib/social/authz.ts`, built on `isActive` / `isAdmin` from `lib/auth/authz.ts`. Deviation from §6's single file, made to keep the shared file untouched during the parallel build; they can move into `authz.ts` later. Every page calls a rule itself, besides the session helpers (§19.9): `/onboarding/creator/connect` `canEditCreatorProfile`, `/onboarding/creator/review` and `/app/audience` `canViewOwnAudience`, `/app/settings/connections` `canManageOwnAccount` plus `canConnectSocial` per provider.

**OAuth flow**
- Start: needs a session (signed out → `/sign-in?callbackUrl=<returnTo>`, since an `/api` path is never a callbackUrl), the provider allowed for the user's roles, its OAuth switched on, and the rate limit `oauth-start` (10 per user per 10 minutes). Every redirect is a 303 to `absoluteUrl()` (NEXT_PUBLIC_APP_URL).
- Callback answers: `returnTo?connected=<provider>` or `returnTo?error=<code>&provider=<provider>`.
  - Codes: the `SocialErrorCode`s, plus `access_denied` (Cancel on the consent screen), `state_invalid` (cookie missing, tampered with, other state, other user), `session_expired` (more than 10 minutes), `account_in_use`, `not_allowed` and `oauth_disabled`.
  - Every page with a Connect or Reconnect button shows the outcome (`ConnectResultAlert`), `/app/audience` included, in all its states.
  - Without a readable cookie the return path is unknown, so it goes to `/app/settings/connections`.
  - The state cookie is cleared on every callback answer.
  - Expected user-side failures (`invalid_code`, `no_channel`, `scope_missing`, `not_eligible`, `rate_limited`) are not sent to Sentry; everything else is.
- Identity is `fetchProfile().providerAccountId`. A reconnect, or a manual entry upgraded to OAuth, updates the existing row: active, `verified_at = now`, sync error cleared, evidence key cleared (the screenshot is deleted, best effort). If the row now points at a different provider account (another channel), **or was a manual entry**, its old snapshots are deleted under `allowGdprErasure` and `last_synced_at` is reset: a typed number must never read as verified once the row is (the card shows "syncing" until the first OAuth sync). The size tier is recomputed in the same transaction and the public profiles are revalidated. `social.connected` is emitted on every successful callback, reconnects included.
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
- **Token-state guard:** every write is conditional on the access-token ciphertext the sync started with (unique per encryption, so it identifies the token): the refreshed tokens, the snapshot (the row is locked `FOR UPDATE` and checked first), `last_sync_error` and the expiry. A reconnect or disconnect while the provider was answering makes the sync drop its results (`skipped: superseded`) instead of writing another channel's numbers onto the new connection, overwriting its fresh tokens, or marking a working connection expired and emailing the user.
- Results: `synced | skipped (not_found, revoked, expired, manual, superseded, oauth_disabled) | expired | failed`.

**Jobs**
- `social-sync` (`social/sync.requested`): 3 retries, concurrency 1 per `connectionId`.
- `social-daily-sync` (cron 04:15 UTC): active OAuth connections not synced in the last 20 hours (switched-off providers excluded), read in pages of 200 by id (keyset), with the cutoff and day fixed in a first memoised step. Under Inngest each page is one step that queries and sends its events in **one batched `inngest.send`** (event id `social-sync:<id>:<day>`, so a retried step or a second run the same day is deduplicated), which keeps a run far below Inngest's step, output-size and batch limits. Inline (fake jobs, `/api/test/jobs/social-daily-sync`) the syncs run in sequence and it returns `{ due, failed }`. `dailySyncFanOut({ step, mode, pageSize?, send? })` is the handler, exported for tests.
- `social-youtube-retention` (cron 03:45 UTC): `purgeExpiredYouTubeSnapshots()` deletes YouTube snapshots older than 30 days except each connection's newest; other providers are untouched; `{ skipped: true }` when `YOUTUBE_LONG_RETENTION=true`.
- Open item: Google's other rule (delete within 30 days once a token can no longer be refreshed) is not implemented for expired YouTube connections; decide together with the retention flag.

**Size tier:** the largest single platform's followers, not the sum (audiences overlap). Verified connections (active and `verified_at` set) are preferred; otherwise other non-revoked creator connections (unverified manual entries, expired ones), and the tier shows as "Unverified". Boundaries: < 10K nano, < 100K micro, ≤ 500K mid, > 500K macro. GitHub never counts. It is recomputed inside the transaction of every snapshot, expiry, disconnect, manual entry and verification.

**Audience summary and topics**
- The sync writes `creator_profiles.audience_summary` **and `topics`** (the AI topics) unless `audience_summary_edited_at` is set. Profile forms that edit `topics` should set `audience_summary_edited_at` too, or the next sync overwrites them.
- No audience data → no model call. A failed generation keeps the old summary. An edit saved while the model runs wins (conditional update).
- "Regenerate" (5 per user per hour) forces a new summary and clears `audience_summary_edited_at`.
- Events:
  - `ai.generated` at generation: subject `creator_profile`, actor null for syncs, `accepted_by_user: null`, `fallback`.
  - `ai.reviewed` when the creator confirms the AI text (`accepted`) or changes it (`edited`), on the review page or `/app/audience`: **once per generation** (an `ai.reviewed` on the profile since `audience_summary_generated_at` means it is decided), so saving the accepted text again, or editing it later, records no second decision. A new generation can be reviewed again.
  - `creator_profile.updated { fields, source }` for edits, which also set `audience_summary_edited_at`.
- On `/onboarding/creator/review`, "Continue" saves the summary and topics, emits those events and records `creator.review` done, all in one transaction.
- The form (`AudienceSummaryForm`) uses `useFormAction`, so a refused save keeps what was typed. The server normalises CRLF line breaks (how browsers submit a textarea) before the 1,200-character check, so a summary that fits the textarea's `maxLength` and counter always fits the schema.

**Embedding:** `creatorProfileEmbeddingText()` (niche, topics, bio, audience summary, languages, country; no names or handles), with `embedding_model` `fake:hashed-bow-1024` or `voyage:<VOYAGE_MODEL>`. An embedding failure is reported and keeps the old vector. Phase 2's `embeddings/refresh` should reuse the same text builder.

**Manual entry fallback**
- Form: profile link (https, on the provider's domain; it is what the admin checks), follower count, screenshot. `checkManualEntryFields()` (client-safe) checks the link and count in the browser **before** anything is uploaded (with the screenshot's type and size; focus moves to the first invalid field) and again on the server. An empty count is missing, never 0.
- Upload: a signed PUT (10 minutes) to the key `social-evidence/<userId>/<provider>-<uuid>.<ext>`.
  - The policy is the image MIME allow-list with a **25 MB** limit (the attachment limit, as the task asked; §19.7 lists screenshots under the 10 MB `image` purpose).
  - The submit checks that the key is under the user's own prefix **for that provider** (`social-evidence/<userId>/<provider>-`), then `statObject`s it (type and size).
  - **Any refusal deletes the upload** (`discardUnusedEvidence`: own prefix for the provider only, and never a key a connection still points at): invalid fields, wrong type or size, an OAuth row, the rate limit.
  - Rate limit `social-manual-submit`: 10 per user per hour.
- Refused while an OAuth row exists for the provider (resync or reconnect instead).
- The screenshot already on file: the very same entry again (same key, count and link, e.g. a retried request) is a no-op (`unchanged: true`, nothing written, an admin's verification stands); other numbers or another link with it are refused ("Upload a new screenshot"): an admin may have checked that screenshot against the old number.
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

**Rate limits:** `oauth-start` 10 per 10 minutes per user; `social-resync` 3 per 15 minutes per connection; `social-evidence-upload` 10 per hour per user; `social-manual-submit` 10 per hour per user; `audience-summary-regenerate` 5 per hour per user.

**Providers whose OAuth is not usable yet** (§7.1 "if a provider's API is not approved yet, allow manual entry")
- `SOCIAL_OAUTH_DISABLED` (comma list of `youtube | instagram | tiktok | github`, `lib/env.ts`; unknown names fail validation; a variable beyond §17, documented in `.env.example`) switches a provider's OAuth off, e.g. `instagram,tiktok` while Meta and TikTok review the apps.
- Its credentials are then **not required in production** (otherwise production could not boot before Meta/TikTok approve the apps). `isSocialOAuthEnabled(provider)` (env) / `isSocialOAuthAvailable(provider)` (`lib/social/availability.ts`) must be checked before `getProvider()`, which throws in production for a provider without credentials.
- Effects: `ConnectButton` renders nothing; connection cards say "Connecting Instagram isn't available yet. Enter your numbers by hand for now; you can connect later." and offer manual entry (GitHub: "not available right now"); start and callback answer `?error=oauth_disabled`; existing connections keep their numbers ("Syncing … is paused"), their syncs are skipped (`oauth_disabled`), the daily fan-out leaves them out, and Resync is refused. Disconnecting still works.

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
- `ConnectButton` / `connectHref(provider, returnTo)` (`components/social/connect-button.tsx`) is the link every Connect button uses, e.g. GitHub on `/onboarding/builder/portfolio`. It is server-only now (it reads `SOCIAL_OAUTH_DISABLED`).
- Mobile: the onboarding connect and review steps put their actions in `FormActions` (components/profiles/form-kit.tsx, §19.15's sticky bottom action bar on phones), like the other onboarding steps.

**Public profiles** (`lib/public-profiles/load.ts`)
- Each loader selects only the public fields listed in its header:
  - Creator: handle, name, bio, niche, topics, languages, country, size tier, and whether the tier rests on verified numbers.
  - The audience summary, and per platform: followers, average views, engagement, verified or unverified, and the date.
  - The channel link only for verified connections. Verified reach is the sum of the verified platforms.
  - Builder: skills, stack, availability, deal preference, portfolio, and GitHub stats.
  - Portfolio images (uploaded through the builder's forms) are shown through their app route `portfolioImagePath(itemId, key)` → `/api/portfolio/<itemId>/image?v=…`; the storage key itself never reaches the page.
- No emails, user ids, tokens, raw payloads, demographic breakdowns or screenshots. Only http(s) URLs reach an `href`.
- Unknown, invalid or suspended → 404. Uppercase handles redirect (308) to lowercase.
- ISR: `revalidate = 300` and an empty `generateStaticParams`, plus a best-effort `revalidatePath` after syncs, expiries, disconnects and summary changes. A 404 can stay cached for up to 5 minutes.
- Metadata: title, description (bio, else summary, else a default; ≤ 160 characters), canonical URL, Open Graph `profile`, Twitter `summary`. No OG image.

**Tests**
- Integration (`tests/integration/social/`):
  - `connection-flow.test.ts`: start and callback, the state cookie, wrong state or user, expiry, cancel, reconnect, `account_in_use`, manual → OAuth upgrade (no typed number passes as verified), `SOCIAL_OAUTH_DISABLED` at start, callback and sync, disconnect.
  - `sync.test.ts`: snapshot, summary, tier, embedding and events; edited summary kept; model fallback; token refresh; expiry with notification and email; retryable errors; a sync superseded by a reconnect (no snapshot, no expiry); GitHub; jobs, including the paged, batched fan-out under Inngest; retention and its flag; manual entry (refusals delete the upload, provider prefix, no-op and reuse rules) and admin verification; review events once per generation.
  - `actions.test.ts`: the server actions with a mocked session: manual submit field errors and rate limit (uploads deleted), `ai.reviewed` once per generation.
  - `public-profiles.test.ts`.
- Unit: `tests/unit/social/connection-pure.test.ts` (incl. `checkManualEntryFields`, CRLF), `tests/unit/social/oauth-availability.test.ts`.
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
- **Creator form:** display name, handle, niche, bio, topics, country, languages. Topics joined the form in the second pass; see §19.17 for how they interact with the audience summary.
- **Builder form:** display name, handle, bio, skills, stack, availability (default `open`), deal preference (default `either`).
  - Skills and stack: ≤ 12 items of ≤ 40 characters, duplicates dropped ignoring case, the first spelling kept. Entered with a tag input since §19.17; the server still parses one comma list.
- **Limits:** names 60 characters, bio 500, niche 80, ≤ 6 languages.
- **Country:** optional, any ISO 3166-1 alpha-2 code (plus XK). It preselects the payout country (§19.12).
- **Languages:** 49 ISO 639-1 codes (common creator languages plus the EU languages), stored lowercase in list order and shown by English name on public profiles. Twelve are shown up front, the rest under "More languages".
- **After the commit, in the background:**
  - `runInBackground` moved to `lib/jobs/background.ts` and takes an `area` tag; `lib/social/background.ts` wraps it.
  - The creator embedding (lib/social/derived.ts) is refreshed when niche, bio, topics, languages or country changed.
  - The builder embedding (`builderProfileEmbeddingText`: skills, stack, bio, portfolio items; no names) is refreshed when bio, skills, stack or the portfolio changed. Phase 2's `embeddings/refresh` should reuse both text builders.
  - Public profiles are revalidated, and after a rename the old handle's paths too.

**Handles**
- **Input:** typed with or without `@`, in any case, and stored lowercase.
- **Reserved:** `RESERVED_HANDLES` (admin, support, staff, official, vincera, …), so no profile can pose as the platform; route words were added in §19.17.
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
- Image: optional upload since §19.17 (`image_url` holds the storage key).
- **Events:** changes emit `builder_profile.updated { fields: ["portfolio_items"], source }`. §11 has no portfolio event, and for matching it is the builder profile that changed.
- **Onboarding:** "Continue" (`finishPortfolioStep`) needs ≥ 1 item or a GitHub connection, like the connect step; otherwise the page offers "Do this later".

**Other pages**
- **Role page:** roles the user already has are marked and disabled. A user with both roles sees a link to `/app` instead of the form. Each card lists what the role does (§19.17).
- **`/app` home:**
  - Cards come from the real state: connections, portfolio, payouts.
  - A role without a profile shows "Set up your <role> profile" (§19.11).
- **Settings:**
  - Every settings page has the tabs from `SETTINGS_NAV` (lib/nav.ts, also the sidebar's children): Profile, Connections, Payouts, Notifications, Account.
  - **Profile:** the user's profiles, active role first, plus the portfolio for builders; in tabs when the user has both roles (§19.17). A missing profile links to its onboarding step.
  - **Notifications:** email and in-app switches per `NOTIFICATION_TYPES` entry, upserted into `notification_prefs`. Built ahead of Phase 3 because the sidebar links to it and `notify()` already reads the switches.
  - **Account:**
    - Name (`users.name`).
    - Sign-in email, read-only: changing it needs a verification flow that is not built.
    - Roles: the missing one can be added through `/onboarding/role`.
    - Session count, and "Sign out everywhere", which deletes every `sessions` row and then signs this browser out.
    - Data export and deletion: disabled buttons with a note (§19.17 replaced the earlier "no dead buttons" text, as the task asked). Active role and "Sign out" (this device) were added there too.

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
- **E2E:** `tests/e2e/onboarding-profiles.spec.ts` (was `onboarding.spec.ts`; renamed and extended in §19.17):
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

### 19.16 Fake AI output must read like the real thing
- **Rule:** every prompt definition in `lib/ai/prompts/` provides `fake(input)`. It returns a realistic, deterministic output built only from the typed input, and that output must pass the prompt's output schema. Examples: an idea brief drafted from the pasted comments; a match explanation naming the two top features with their values; launch posts that use the launch title, price and tracked link.
- **Wiring:** callers pass `fakeOutput: () => prompt.fake?.(input)` to `generateStructured` / `generateText`. The fake transport (`lib/ai/fake.ts`) returns it when the AI service is fake.
- **Without a `fake`:** the transport falls back to schema-shaped placeholders ("Stub …"). Never ship a prompt without `fake`: local runs, the Docker demo and screenshots should read naturally.
- **Failure paths:** the markers `FAKE_AI_INVALID`, `FAKE_AI_REFUSAL` and `FAKE_AI_ERROR` still force them.
- **Reference implementation:** `fakeAudienceSummary` in `lib/ai/prompts/audience-summary.ts`.

### 19.17 Phase 1: profile forms, second pass (topics, live handle check, portfolio images, mobile actions)
Decisions made while finishing the onboarding forms, profiles and settings against the Phase 1 task list.

**Creator topics on the profile form**
- The creator form has a Topics tag input (≤ 8, ≤ 40 characters each). Topics use the audience summary's rules: lowercase, `#` and duplicates dropped (`parseTopicsInput` from `lib/social/summary-form.ts`, each comma part trimmed first). §5 lists `topics` on `creator_profiles`, and the task asked for them on the form.
- They interact with the AI summary (§19.14) like this:
  - Before the profile has an audience summary, topics typed on the form only seed it. The first sync passes them to the model (`profileTopics`) and may replace them with its own; the creator then reviews them on the review step.
  - Once a summary exists, a topic change on the form also sets `audience_summary_edited_at`, so later syncs keep the creator's topics and summary, as an edit on `/app/audience` would. "Regenerate" still clears it.
  - Edits to other fields never set it.
- `creator_profile.created.topic_count` now counts them. A topic change refreshes the embedding.

**Tag inputs** (`components/profiles/tag-input.tsx`, pure logic in `tag-list.ts`)
- Used for topics, skills and stack. Enter or a comma ends a tag, Backspace in the empty box removes the last one, and each chip has a "Remove <kind> <tag>" button.
- The form gets one hidden field holding the tags, plus any text still being typed, as a comma list. So the server schemas did not change, a pasted list works, and nothing typed is lost without a blur.
- Tags beyond the limit stay in the box and are submitted, so the server's message explains the limit.
- `tagListSchema` also accepts repeated fields.

**Handles**
- **Live check** under the handle field:
  - Format and reserved words are checked in the browser at once. After a 400 ms pause, `checkHandleAvailabilityAction` (`handleAvailability`, lib/profiles/handles.ts) answers `available | yours | taken | reserved | invalid`.
  - Authorized with `canManageOwnAccount`; rate-limited at 60 per user per minute (bucket `handle-check`). A limited or failed check shows nothing.
  - It is a hint only: saving claims the handle. Handles are public (`/c/<handle>`), so the check reveals nothing new.
- **Reserved words** now include the app's route segments (access, api, app, auth, builders, creators, dev, discover, earnings, launches, legal, login, logout, messages, notifications, oauth, onboarding, payouts, pricing, privacy, proposals, settings, sign_in, sign_up, signin, signup, terms, webhooks). The one-letter public prefixes `c`, `b`, `p`, `r` are listed too, although the 3-character minimum already refuses them. No stored handle used any of these words (the seed creates no profiles).
- **Concurrency:**
  - Every profile save first locks the user's `users` row. Two saves of one user (a double submit, two tabs) run one after the other, so the second updates what the first created instead of failing on `creator_profiles_user_id_unique`.
  - Two people racing for one handle are settled by `claimHandle`. The later insert waits for the earlier transaction, then finds the handle taken and gets `HandleTakenError`: "That handle is taken. Try another one." on the handle field.
  - Any other unique violation during a save becomes a plain-language error (`withPlainUniqueErrors` in `lib/profiles/save.ts`).
  - Integration tests cover the blocked-claim case deterministically (one transaction held open) and in parallel rounds.

**Portfolio images** (`lib/profiles/image-policy.ts` client-safe, `lib/profiles/portfolio-image.ts` server)
- **Policy:** the `image` upload purpose (§19.7): PNG, JPEG, WebP, GIF; 10 MB; never SVG.
- **Upload:**
  - The dialog checks the file, asks `requestPortfolioImageUpload` (builders only; 20 per user per hour, bucket `portfolio-image-upload`) for a 10-minute signed PUT, uploads the file directly, then submits the project with `imageKey`.
  - Keys are `portfolio-images/<userId>/<uuidv7>.<ext>`. On save the key must match the user's own prefix and that exact shape (`isOwnPortfolioImageKey`), and the stored object is `statObject`-checked; an object of the wrong type or size is deleted (R2 cannot cap a presigned PUT). **Superseded by §19.19:** uploads go to `portfolio-uploads/` and a save copies them to a fresh `portfolio-images/` key.
  - "Remove image" sends `removeImage`.
- **Storage column (deviation):** `portfolio_items.image_url` stores the storage key, not a URL, because schema changes were off-limits in this wave and storage is private (§14). A later migration may rename it `image_storage_key`.
- **Cleanup:** replaced, removed and deleted images are deleted from storage after the commit (best effort, `runInBackground`). An image uploaded in a dialog that is then cancelled stays orphaned (TODO: sweep `portfolio-uploads/` objects older than an hour, and unreferenced `portfolio-images/` ones, e.g. with the Phase 6 GDPR work). Refused saves clean up after themselves since §19.19.
- **Display:** `GET /api/portfolio/<itemId>/image` (`app/api/portfolio/[itemId]/image/route.ts`, a redirect route handler, §4) answers 302 to a 10-minute signed GET URL with `Cache-Control: private, max-age=300`. It answers 404 for unknown ids, items without an image, keys outside the owner's prefix, and suspended owners.
  - Pages use `portfolioImagePath(itemId, key)`, which adds `?v=<upload id>` so a replaced image is never served from cache.
  - Portfolio images are public profile content, so the route needs no session. `/b/[handle]` (§19.14) shows them through the same `portfolioImagePath`, never the storage key.
  - Plain `<img>` with a lint exception: `next/image` would need every storage host configured, and the source is a redirect.

**Pages**
- **Role page:** each card lists what the role does. Radios are named by the card title (`aria-labelledby`) and described by the rest. The cards use spans only (a list is not valid inside a `<label>`).
- **Mobile action bar:** `FormActions` (`components/profiles/form-kit.tsx`) holds a form's Save / Continue. Below `sm` it sticks to the bottom of the screen above the home indicator (`env(safe-area-inset-bottom)`), like an app's action bar; from `sm` up it is a plain row. Used by both profile forms, the role picker and the portfolio step. This is the "like a mobile app" part of the user's request within this area.
- **Settings → Profile:** with both roles, the two profiles sit in tabs (`Your profiles`), the active role first, and `?tab=creator|builder` opens one. Both panels stay mounted (`forceMount`, hidden when inactive), so unsaved edits survive switching tabs.
- **Settings → Account:**
  - Active role (`ActiveRoleForm`, the sidebar switcher's `switchActiveRole` action), and "Sign out" for this device next to "Sign out everywhere".
  - "Export my data" and "Delete account" are disabled buttons whose description says they come with the data-protection tools later in this build (§14, Phase 6). The task asked for disabled buttons, so this replaces §19.15's "no dead buttons".

**Tests**
- Unit: `tests/unit/profiles/fields.test.ts` (topics, reserved route words, image fields and policy, `portfolioImagePath`), `tag-list.test.ts`, and `profile-ui.test.ts` (server-rendered forms: labels, hidden tag fields, live-status region, role cards, image thumbnails, active role).
- Integration: `tests/integration/profiles/profile-forms.test.ts` covers the handle check and its action, handle races (blocked claim, parallel rounds, double submit), topics and `audience_summary_edited_at`, image upload URLs, key and object checks (other user's key, missing upload, HTML disguised as PNG, oversize), replace, remove and delete, the image route, and upload authorization. `profiles.test.ts` was updated for the new return shapes.
- E2E: `tests/e2e/onboarding-profiles.spec.ts`, not run in this wave (e2e runs at the gate). It covers:
  - creator: role cards → profile (reserved and available handle hints, validation that keeps input, topic tags) → connect "Do this later" → review (cannot be skipped) → payouts "Do this later" → `/app`; then settings edits persist after a reload, the public URL follows a rename, notification switches, and the account page (disabled GDPR buttons, rename, sign out everywhere);
  - builder: taken-handle hint and refusal → profile with tags → portfolio (GitHub link target, SVG refused, image upload shown through the image route, image removed, edit, remove) → payouts later → `/app` → settings skill tags persist;
  - both roles: shared handle ("This handle is yours."), profile tabs and `?tab=builder`, switching the active role changes `/app`, and sign out from Account.

### 19.18 Phase 1 gate, second pass (W1b): Supabase, the mobile app shell, hardening
The user asked to "put the DB on Supabase, make it like a mobile app and launch it on localhost". This pass ran the Phase 1 gate again after the second wave and covered the first two parts; the decisions:

**Database on Supabase** (`lib/db/connection.ts`, README "Database on Supabase") — **TLS resolution, the "new tables must use `withRLS`" rule and the Docker database are superseded by §19.21.**
- The platform keeps talking to Postgres directly (Drizzle over `pg`); Supabase is the host. No Supabase client library, no Data API.
- `DATABASE_CA_CERT` (new, beyond §17, optional): the PEM of the CA that signs the server's certificate. Supabase uses its own root CA, so node-postgres's `sslmode=require` (which it treats as verify-full) fails without it. `databasePoolConfig(url, { caCert })` then drops the URL's `ssl*` parameters (node-postgres lets them override the `ssl` option) and verifies the server. One-line values with `\n` escapes are accepted. The app (`getDb`), `pnpm db:migrate` and `pnpm admin:grant` use it.
- Production refuses a Supabase `DATABASE_URL` (`*.supabase.co`, `*.supabase.com`) unless the server is verified against a CA we supply: `DATABASE_CA_CERT`, or `sslrootcert` in the URL (§19.19; before, any `sslmode` but `disable` passed, including ones that fail on connect).
- The transaction pooler (port 6543) works: drizzle sends unnamed statements, `app.gdpr_erasure` is transaction-local, and only the test tooling uses advisory locks. Migrations should use the session pooler or the direct host.
- **Data API lockdown:** every table is created with row-level security on and no policies (`withRLS(pgTable(...))` from `lib/db/schema/columns.ts`, migration `0007`); `0008` revokes `anon` / `authenticated` grants and their default privileges in `public` when those roles exist (nothing happens elsewhere). The app connects as the tables' owner, which RLS does not restrict (not `FORCE`d). New tables must be wrapped in `withRLS`; `tests/integration/db/rls.test.ts` fails otherwise. `withRLS` keeps the table type (drizzle's `.enableRLS()` returns an `Omit<>` that Auth.js's adapter types reject).
- The platform needs a Supabase project of its own: the legacy bot's project also has `events` and `messages` in `public` (the migrations would stop at `0001`), and `0008` revokes the API roles on every table in `public`.
- **Verified on Supabase's Postgres** (`supabase/postgres:17.11.0.003`, the image `supabase start` runs, where `postgres` is not a superuser and the API roles have default privileges): all migrations apply (`CREATE EXTENSION vector`, the append-only triggers), `anon` / `authenticated` end with no grants and every table has RLS, the whole integration suite passes (213 tests), and the Phase 1 walk below ran with the app on that database. CI runs the migrations, the grant check and the integration suite on that image (job `supabase-postgres`). No real Supabase project was available: connecting a hosted one needs its connection string and CA certificate.

**Mobile app shell** ("make it like a mobile app")
- **Superseded by §19.20** (tabs Home, Discover, Collabs, Inbox, Me; no "More"; a top app bar; a service worker; committed icons). **Bottom tab bar** (`components/layout/mobile-tab-bar.tsx`, below `md`, signed-in app only): four tabs from `appTabs(role)` in `lib/nav.ts` (every tab is also a sidebar item), and "More", which opens the sidebar sheet with the full menu. Since §19.19 only built pages become tabs: Home, Audience, Profile, Payouts (creators) and Home, Profile, Connections, Payouts (builders) in Phase 1; Products, Discover and Collabs take their places as they land.
- While the tab bar shows, `app/globals.css` sets `--sticky-bottom` (its height plus the home indicator) on `body`; page content pads by it, `FormActions` sticks above it (`bottom: var(--sticky-bottom)`), and toasts sit above it (`mobileOffset`). Onboarding has no tab bar; its `FormActions` stick to the bottom as before.
- **Installable** (**superseded by §19.20**: committed icons under `public/icons/`, shortcuts, a service worker with an offline page)**:** `app/manifest.ts` (standalone, `start_url` and `id` `/app`, dark tile colour), PNG icons rendered at build time from the logo mark (`app/pwa-icons/[file]` 192, 512 and maskable 512; `app/apple-icon.tsx` 180), `appleWebApp` metadata and `viewport-fit=cover` so the bottom bars can pad with `env(safe-area-inset-bottom)`. No service worker or offline mode: every page needs the server.
- (**Superseded by §19.20**: `app/favicon.ico` is a real ICO file now.) `/favicon.ico` answers 308 to `/icon.svg`: the raw HTML pages (fake provider pages, dev mailbox) link no icon, and browsers logged a 404 for them.

**Hardening (review findings carried over from the second wave)**
- **Dev mailbox:** `/api/dev/mailbox` (added with the Docker setup, not recorded before) lists every fake email, magic links included. It now needs `DEV_MAILBOX=1` as well as fake email and a non-production `APP_ENV` (`devMailboxEnabled()`); production refuses the flag. Docker Compose sets it and publishes port 3000 on `127.0.0.1` only.
- **Database errors before Sentry and the logs:** drizzle's `DrizzleQueryError` message carries the query parameters, and Postgres errors carry row values in `detail`. `redactDbError` (`lib/db/errors.ts`) copies such errors with `params: [redacted]`, without `detail` / `where`, with quoted input in invalid-input messages redacted, and with SQLSTATE, constraint and table kept (so `isPgError` still works). `reportError` and the scripts' `describeError` use it; Sentry's `beforeSend` (`scrubEvent`) also strips failed-query parameters from exception values, breadcrumbs and messages that reach Sentry another way.
- **`notify` dedupe with in-app off:** see §19.11 (`notifications.in_app`, migration `0006`). Before, a user with in-app switched off got the email again on every retry.

**Gate results (2026-10-05)**
- CI on the pushed head (`b35494e`): green (the `supabase-postgres` job is new and has not run on GitHub yet; it was simulated locally with a clean environment on a fresh container: migrations, the grant check and 213 integration tests pass). Locally: typecheck, lint, format, unit + integration (71 files, 769 tests), build, and e2e under `next dev` and under `CI=1` (build + start), 19/19 each.
- The Phase 1 walk on `pnpm dev` (`FAKE_SERVICES=all`, database: the Supabase Postgres container), scripted with Playwright: a creator connects YouTube (fixture "Ada Codes") and `/app/audience` shows 48.2K subscribers, countries and age bars; a builder connects GitHub; both finish fake Stripe Connect (signed `account.updated` delivered and processed, `stripe_accounts` payouts enabled with transfers active, Settings → Payouts "Payouts are ready", `payouts.ready` notified once); `/c/<handle>` and `/b/<handle>` render; at 390 px in dark mode no page scrolls sideways, the tab bar and "More" work, and the profile form's Save bar sits above the tab bar. Tokens are stored encrypted (`v1:` ciphertext) and no event property holds an email or a token.
- E2E: `tests/e2e/mobile.spec.ts` (new) covers the tab bar, "More", the Save bar above the tabs, dark mode, no sideways scroll, and the manifest and icons.


### 19.19 Phase 1 gate, third pass (W1c): review findings
Decisions made while fixing the W1 review findings.

**No dead ends in the app** (`lib/nav.ts`)
- `BUILT_ROUTES` lists the menu pages that exist in this build; `isBuiltRoute(href)` reads it. `tests/unit/nav.test.ts` compares it with the `page.tsx` files under `app/` in both directions, so **a phase that adds a page must add it there** (the test fails otherwise), and its tab, menu link and home card come back by themselves.
- Tabs (**superseded by §19.20**: five tabs, the last one Me): `appTabs(role)` takes the first four built pages from a preference list (Home, Audience | Products, Discover, Collabs, then Profile, Payouts / Connections). Phase 1: creator Home, Audience, Profile, Payouts; builder Home, Profile, Connections, Payouts.
- Sidebar (app and admin): §12 items that are not built yet stay listed, dimmed and not linked, with a "Soon" badge (`aria-label "<title> (coming soon)"`); §19.8's "menus list §12 routes" still holds. Their unbuilt children are not shown.
- `/app` home: cards for unbuilt pages show a "Coming soon" badge instead of a link; the "Proposals" button and the header's notifications bell appear when their pages exist. The admin overview's cards link only to built pages.
- 404s keep the shell: `app/app/[...missing]/page.tsx` and `app/admin/[...missing]/page.tsx` call `notFound()` (after `requireOnboardedUser()` / `requireAdmin()`), so `app/app/not-found.tsx` / `app/admin/not-found.tsx` render inside the layouts with the sidebar and tab bar. `ShellNotFound` says "Coming soon" for a path under a planned menu item (`plannedNavItem`, e.g. `/app/ideas/new` → Ideas) and "Page not found" otherwise, with "Go to home". Status 404 either way.
- Errors keep the shell too: `app/app/error.tsx` and `app/admin/error.tsx` (`ShellError`: "Try again" with Next 16's `retry`, and a way home); `app/error.tsx` covers everything else, including a failing app layout. Browser-side errors (no `digest`) are reported to Sentry there; server errors were already reported by `onRequestError`.
- `app/not-found.tsx`: the site header and footer, "Go to the home page" and "Open the app", for unmatched URLs outside `/app` and `/admin` and for unknown public profiles. `/app/settings` redirects to `/app/settings/profile`.
- Not built: no global-error.tsx (the root layout has no data), no `/app/notifications` page (Phase 3; in-app notifications are stored but not listed yet).
- `next.config.ts` sets `devIndicators: false`: under `pnpm dev` on a phone, Next's route indicator (bottom-left) covered the tab bar's Home, and every other corner holds a control too. Compile and runtime errors still show.
- next-themes' inline theme script gets `type="application/json"` when rendered in the browser (`scriptProps`, `components/theme-provider.tsx`): Next renders not-found pages' root layout on the client, where React 19 logged "Encountered a script tag while rendering React component" as an error (an Issues badge over Home under `pnpm dev`). The server's script still runs before the first paint. The mobile 404 e2e test fails on any console error.

**Topics:** `normalizeTopic` (`lib/social/summary-form.ts`) is the one rule: trim, lowercase, drop leading `#`, `_` and whitespace runs to one space. `parseTopicsInput` (both forms) and `normalizeAudienceSummary` (the AI's topics) use it, so ", #budget" is "budget" everywhere. The profile form's own pre-split is gone.

**Page authorization:** `authorizePage(allowed, fallback?)` (`lib/auth/session.ts`) redirects when a rule says no (default: the sign-in page's "account suspended" message). Every signed-in page now calls a rule itself: `/app` (`canManageOwnAccount` and the active role's `canEdit<Role>Profile`, else the role step), `/app/settings/payouts` and `/onboarding/payouts` (before the Stripe re-fetch), `/app/settings/notifications`, `/onboarding/role`, `/admin` (`canAccessAdmin`). `tests/unit/auth/page-authz.test.ts` reads every `page.tsx` under `app/app`, `app/onboarding` and `app/admin` and fails when one imports and calls no rule with the user; pages that load no data (the catch-alls, the settings redirect) are listed with the reason.

**Supabase TLS in production** (`lib/db/connection.ts`): `databaseTls(url, { caCert })` classifies a connection as `own_ca`, `public_ca`, `unverified` or `none`, mirroring the installed pg-connection-string (a unit test compares the two over every `sslmode` / `sslrootcert` / `uselibpqcompat` combination, so a `pg` upgrade that changes the semantics fails it). `supabaseTlsProblem()` accepts a Supabase host only with `own_ca`: `DATABASE_CA_CERT`, or an `sslrootcert` file in the URL. `sslmode=require`, `prefer`, `verify-ca` and `verify-full` without a CA would validate but fail on connect against Supabase's private CA; `no-verify` and libpq-compatible `require` skip verification. The message names where the certificate is (Database settings → SSL configuration).

**Portfolio images** (`lib/profiles/portfolio-image.ts`; supersedes the key and check rules of §19.17)
- Upload URLs point at `portfolio-uploads/<userId>/<uuidv7>.<ext>` only. A save accepts only such a key (`isOwnPortfolioUploadKey`), copies it on the server to a fresh `portfolio-images/<userId>/<uuidv7>.<ext>` key that was never presigned (`ObjectStorage.copyObject`, new: R2 `CopyObject`, a file copy in the local fake), and checks the **copy** (type, size, and the type the extension names). The copy is what `image_url` stores and the image route serves, so the reusable 10-minute PUT URL can no longer change or enlarge a saved image (nor can a re-PUT between the check and the copy).
- Keys are per project: the same upload saved twice fails the second time (it was used up), and another project's saved key is refused (not an upload key). The item's own current key keeps its image. `deletePortfolioImage(db, key)` skips a key any row still references (rows saved before this change may share one). No unique index on `image_url`: the app can no longer produce duplicates, and a migration would fail on existing duplicated rows.
- Cleanup: the upload is deleted after every save, accepted or refused (`discardPortfolioUpload`, own upload keys only); a promoted copy is deleted when the transaction fails (the 12-project limit, a missing profile) or the item is gone. The project actions parse the fields in `run` (`portfolioActionInput` is a loose object with `from` and `imageKey`), so invalid fields delete the upload too; the response has the same `fieldErrors` as before.
- Existing `image_url` keys stay valid (same `portfolio-images/` shape). Their old PUT URLs expired within 10 minutes of being issued.
- Deferred: manual-entry evidence screenshots keep their upload key (§19.14). Only admins see them, through 5-minute signed URLs; promoting them would change the "same entry again is a no-op" rule. Revisit with the Phase 6 admin UI.

**Sentry breadcrumbs:** `scrubBreadcrumb` (`sentry.shared.ts`) drops console breadcrumbs' `data.arguments` (raw console arguments; a `DrizzleQueryError` among them carries `query` and `params`) and scrubs every breadcrumb's message. It is installed as `beforeBreadcrumb` and applied again by `scrubEvent`.

**Sign-in codes for the installed app** (`lib/auth/sign-in-code.ts`, `lib/auth/email-callback.ts`)
- iOS home-screen web apps keep their own cookie jar, so a magic link tapped in Mail signs Safari in, never the installed app (from Apple's documented storage behaviour; not tried on a device here). Auth.js's email provider now generates the token as an 8-character Crockford base32 code (`generateVerificationToken`), which the email shows as `ABCD-EFGH` next to the link. The link is unchanged in form (`?token=<code>&email=…`), still single use and 24 hours.
- "Check your email" (after requesting) has a code field; the sign-in page has "Have a sign-in code?" (email and code); Auth.js's verify-request state has one too. They are plain GET forms to `/api/auth/callback/email` with `email`, `token` and the same `callbackUrl` the link carries, so the session cookie is set in whatever app or browser the code is typed into.
- The auth route runs `prepareEmailCallback` first: every callback (click or code) counts against `email-callback`, 10 per 10 minutes per client IP and per email, answered with `/sign-in?error=RateLimited` (303) before Auth.js sees it (a wrong guess consumes nothing there). A typed code is normalised (case, dashes, spaces; O → 0, I/L → 1) and the email lowercased as Auth.js stores it. A code only matches the email it was sent to (the adapter looks tokens up by identifier and token). 40 bits with that limit: at most 1,440 guesses a day per address.
- Older links (64-hex tokens) still work: only code-shaped tokens are rewritten.

**Tests added:** `tests/unit/nav.test.ts` (built routes against the file system, tabs, `plannedNavItem`), `tests/unit/auth/page-authz.test.ts`, `tests/unit/auth/sign-in-code.test.ts`, `tests/unit/db/connection.test.ts` (`databaseTls` against pg-connection-string, `supabaseTlsProblem`), `tests/unit/env.test.ts` (Supabase TLS), `tests/unit/sentry.test.ts` (console breadcrumb with a DrizzleQueryError-like argument), `tests/unit/social/connection-pure.test.ts` and `tests/unit/profiles/fields.test.ts` (", #b" on both forms and the AI), `tests/unit/storage.test.ts` (`copyObject`), `tests/integration/profiles/profile-forms.test.ts` (the upload URL reused after a save, shared keys, refused saves and invalid fields leave no objects), `tests/integration/auth/auth-flow.test.ts` (codes: typed in lower case with a dash, once only, per email, guess limits), `tests/e2e/mobile.spec.ts` (every tab opens a real page; no link on `/app` answers ≥ 400; "Coming soon" and "Page not found" inside the shell with the tab bar; the site 404; `/app/settings`), `tests/e2e/auth.spec.ts` (signing in by typing the code).
- `tests/e2e/onboarding-profiles.spec.ts`: after the refused taken-handle submit, the builder test now waits for the server's field error (`aria-describedby` with `-error`) instead of the identical live hint, which was already on screen. Under `next dev` the refused form's restore of the submitted values could land after the next fill and overwrite the new handle (seen once in this pass).

**Running it on localhost against Supabase** (the user's "put the DB on Supabase … launch it on localhost")
- `.env.local` (gitignored) now points `DATABASE_URL` at the Supabase Postgres container from §19.18 (`supabase-db`, image `supabase/postgres:17.11.0.003`, `postgres://postgres:postgres@127.0.0.1:54322/postgres`; the old local URL is kept there as a comment) and sets `DEV_MAILBOX=1`. Tests keep their own databases on the local Postgres (`TEST_DATABASE_URL`, `E2E_DATABASE_URL`). `pnpm db:migrate` applied nothing new (all 9 migrations were there); `anon` / `authenticated` hold no grants and every table has RLS. `pnpm db:seed` is still a no-op (Phase 2).
- `pnpm dev` (`FAKE_SERVICES=all`) was left running on http://localhost:3000 for the user. A scripted phone walk (390 px, dark) on it: sign up, sign in by typing the emailed code, builder onboarding to `/app`, each tab (Home, Profile, Connections, Payouts) opens its page, `/app/discover` shows "Coming soon" in the shell (404), no console errors; the rows landed in the Supabase database.

**Gate results (2026-10-05, W1c):** typecheck, lint, format, unit + integration (73 files, 809 tests), build, and e2e under `next dev` and `CI=1` (build + start): 21/21 each.

### 19.20 Mobile app (PWA) patterns
The user asked to "make it like a mobile app". Native apps are an MVP non-goal (§1), so the platform is a **mobile-first installable PWA**. This replaces the phone shell of §19.18 / §19.19 (tabs, "More", icon routes, "no service worker"). Rules for every page from now on:

**The phone shell** (below `md`; desktop keeps the sidebar and its header unchanged)
- `AppShell` (`components/layout/app-shell.tsx`) renders, on phones: a compact **top app bar** (`app-bar.tsx`: back button or logo, title, one action slot, the bell once `/app/notifications` exists) and, in the app, a fixed **bottom tab bar** (`mobile-tab-bar.tsx`). No sidebar on phones in the app. The admin area keeps its sidebar as a sheet behind the app bar's menu button ("Open the admin menu"), with 44 px rows; no tab bar.
- **Tabs** (`appTabs(role)` in `lib/nav.ts`): Home, Discover, Collabs, Inbox, Me. Only built pages become tabs (§19.19's `BUILT_ROUTES`); until Discover, Collabs and Inbox exist, the role's next built pages fill their slots in order (`MOBILE_TAB_FALLBACKS`: Phase 1 creators Home · Audience · Profile · Payouts · Me, builders Home · Profile · Connections · Payouts · Me). When a phase adds `/app/discover`, `/app/collabs` or `/app/messages` to `BUILT_ROUTES`, the bar turns into the final five by itself; nothing else to register. Inbox (`/app/messages`, also lit for `/app/notifications`) shows `unreadNotifications + unreadMessages` (ShellProps, passed by the app layout once Phase 3 counts them) as a badge.
- **Me** (`/app/me`, a page beyond §12; deviation): avatar, name, email, active role; the role switch (`ActiveRoleForm`) or "Become a … too"; links to the person's public pages; every `appNav` item that is not a tab right now (built, or dimmed with "Soon") and all five settings pages (`mePageSections(role)`); Admin area for admins; "Install the app"; Appearance (light / dark / auto, `ThemeChoice`); Sign out. Me is the active tab for every app page outside the other tabs. `tests/unit/nav.test.ts` checks that tabs + Me reach every `appNav` destination for both roles, v1 included, so a new sidebar item is automatically on the phone too.
- **Title, back, action**: the bar's title defaults to the deepest menu entry containing the path (`shellTitle`), else `APP_NAME`; the back button to the nearest existing parent page (`shellBackHref`: tabs and `/admin` sections have none; settings and the app's own sections go back to Me; menu pages a later phase builds are skipped; dynamic parents like `/app/collabs/<id>` are assumed to exist). A page that knows better renders `<AppBarSlot title="Collab with @ada" back="/app/collabs" action={<Button size="icon" className="size-11" aria-label="New task">…</Button>} />` (`components/layout/app-bar-slot.tsx`; `back={null}` hides it). It applies after hydration (the server renders the defaults) and the last mounted slot wins. The action shows on phones only: keep the desktop version in `PageHeader`, and hide that one below `md` (`hidden md:inline-flex`) when it would appear twice. Example in use: `ShellNotFound` ("Page not found", back home).
- On a tab's own page the bar shows the logo instead of a back button, and the title fades in as the page's `h1` scrolls away (CSS scroll-driven animation; reduced motion or older browsers just show it).
- **Layout rules for pages**: keep one `h1` per page (`PageHeader`); the shell pads content by the safe areas and by `--sticky-bottom` (the tab bar plus home indicator), so pages add no bottom padding of their own. Sticky primary actions go in `FormActions` (components/profiles/form-kit.tsx), which sticks above the tab bar on phones. Long lists and tables scroll inside their own `overflow-x-auto` box, never the page. Use **sheets, not hover**: anything behind hover or a tooltip needs a tap path; for pickers and multi-step choices on phones use `Sheet side="bottom"` (`rounded-t-2xl pb-safe-6`, like the iOS install steps in `components/pwa/install-prompt.tsx`); dialogs are fine for short confirmations. Buttons that are drawn smaller than 44 px still get a 44 px tap (below), but give new icon-only controls `size-11` on phones.
- **Global CSS** (`app/globals.css`, "Mobile app (PWA) layer"): safe-area utilities `pt-safe`, `pb-safe`, `pl-safe`, `pr-safe`, `px-safe-<n>` (at least n spacing units, more under a notch), `pb-safe-<n>`, `pt-safe-<n>`; `--sticky-top` / `--sticky-bottom` feed `scroll-padding`, so focused fields and anchors never hide under a bar; no tap highlight; inputs, selects and textareas at least 16 px on touch screens and phones (iOS zooms into smaller fields); on coarse pointers `[data-slot=button]` and other small controls (Radix triggers rendered `asChild` around a Button carry the trigger's `data-slot`, so those are listed too) get an invisible hit area of at least 44 × 44 px (`::after`, in the base layer so `absolute` utilities still win), and labels wrapping a native checkbox or radio are at least 44 px tall; sheets, dialogs and menus contain their scroll (`overscroll-behavior: contain`); `prefers-reduced-motion` stops animations and transitions; in `display-mode: standalone` no rubber-band overscroll and no link previews on long-pressing the bars. Marketing, auth, onboarding and public-profile layouts pad with the safe-area utilities, and their headers clear the status bar (`pt-safe`).

**Installable app**
- `app/manifest.ts` → `appManifest()` (`lib/pwa/manifest.ts`): `id` and `start_url` `/app`, scope `/`, standalone, `background_color` / `theme_color` `#0a0a0a` (the dark theme's background: the splash and the icon tile are one surface), icons 192/512 as `any` (rounded tile) and `maskable` (full bleed, mark inside the 80 % safe zone), shortcuts Discover, Messages, Audience, **only those whose page is built** (Phase 1: Audience; the others appear with their pages).
- **Icons** are committed PNGs under `public/icons/` plus `app/favicon.ico` (16/32/48) and `app/icon.svg`, generated by `pnpm pwa:icons` (`scripts/pwa-icons.ts`: the logo mark of `lib/pwa/icons.ts` rendered with Playwright's Chromium; shortcut glyphs are lucide icons). Run it after changing the mark, a colour or a size; `tests/unit/pwa.test.ts` fails when a file and its declared size disagree. The build-time icon routes (`app/pwa-icons/[file]`, `app/apple-icon.tsx`) and the `/favicon.ico` → `/icon.svg` redirect are gone.
- Root metadata: `viewport` (device-width, initial scale 1, `viewport-fit=cover`, `theme-color` per scheme, `color-scheme`), `appleWebApp` (capable, title, **status bar `default`**: with `black-translucent` the clock would be white on the light theme; the bars still pad with `env(safe-area-inset-*)`), `apple-touch-icon` 180 px, `formatDetection` off for phone numbers, emails and addresses. `ThemeColorSync` moves `theme-color` to the theme chosen in the app (the meta tags alone follow the system setting; **§19.23**: it lives in the root layout and survives client-side navigations).
- **Install prompt** (`components/pwa/install-prompt.tsx`, logic in `lib/pwa/install.ts`): a card at the bottom of `/app` (only signed-in, onboarded people see the shell). Chrome/Edge get "Install" (the kept `beforeinstallprompt` event; `startInstallListener` runs from `PwaRuntime` so the event is not lost before the card mounts); iPhone/iPad get "Show me how", a bottom sheet with Share → Add to Home Screen (**§19.23**: worded for Safari, Chrome or other iOS browsers; none in apps' built-in browsers) (and a reminder that the home-screen app signs in with the emailed code, §19.19). Hidden when running standalone, where the browser cannot install, and for 60 days after "Not now" (`localStorage` `pwa:install-dismissed`, read and written in try/catch; without storage it hides for the page view). Me keeps a permanent "Install the app" row.

**Service worker and caching rules** (`public/sw.js`, hand-written, `VERSION` constant)
- **Never cache authenticated content.** Phones get shared: the worker stores only the public offline page (fetched with `credentials: "omit"`) with the static files it needs, `/_next/static/*` (content-hashed) and `/icons/*`. It never stores a navigation, an RSC payload, a server action, `/api/*`, `/sign-in`, `/sign-up` or `/sw.js`; requests it does not handle go to the network untouched. Static responses marked `private` or `no-store` are not stored either; at most 250 static entries are kept (**since §19.23** the offline page's own files live in the offline cache, which is never trimmed).
- Navigations are network-first; when the network fails, `/offline` (`app/offline/page.tsx`, static, no session) is the only fallback, shown at the requested address, with "Try again" and an automatic reload when the connection returns. **No navigation preload**: the browser sends the preload request for every navigation, also those the worker leaves to the network (`/api/*`), so single-use URLs (magic links, OAuth callbacks) were fetched twice and the real navigation failed (`?error=Verification`). The worker disables it on activation; `tests/unit/service-worker.test.ts` checks that it stays off.
- Updates: a changed `sw.js` installs and waits; the page shows a toast "A new version of the app is ready." with Reload, which posts `SKIP_WAITING` and reloads on `controllerchange` (only when asked: the first install's `clients.claim()` must not reload the page). The app checks for updates when it comes back to the foreground. **Bump `VERSION`** whenever `sw.js` changes in a way that needs fresh caches (**§19.23**: a changed offline page needs no bump, the daily snapshot refresh picks it up); activation deletes older `app-*` caches.
- Registration (`components/pwa/service-worker.tsx`, mounted by `PwaRuntime` in the app/admin shell, onboarding and marketing layouts): production builds only, or with `NEXT_PUBLIC_ENABLE_SW=1` (`=0` turns it off in production too; build-time value, `lib/pwa/sw-config.ts`; a variable beyond §17, add it to `.env.example` with the other `NEXT_PUBLIC_*` when that file is next edited). Where it is off, the page unregisters our worker and deletes the `app-*` caches, so a worker left by a production run on the same origin (`docker compose up`, then `pnpm dev` on port 3000) cannot keep serving that build's files. Playwright's web server sets `NEXT_PUBLIC_ENABLE_SW=1`, so e2e under `next dev` runs with the worker like CI's production build does. `next.config.ts` serves `/sw.js` with `Cache-Control: no-cache, no-store, must-revalidate`, a JavaScript content type and `default-src 'self'`.
- `tests/unit/service-worker.test.ts` runs the real `sw.js` in a simulated worker scope (node:vm, in-memory caches) and pins these rules; the e2e test below checks them in Chromium.

**Testing on phones** (`playwright.config.ts`)
- Project **`mobile`**: an iPhone 13 (390 × 664, touch, iOS user agent) on Chromium; runs `tests/e2e/mobile.spec.ts` and `tests/e2e/mobile-<topic>.spec.ts`. The desktop project (`chromium`) runs everything else, including `mobile-desktop.spec.ts` (the sidebar stays, no tab bar or app bar). New flows should get a phone check here; `pnpm test:e2e --project=mobile` runs only these.
- `mobile.spec.ts`: tabs per role with aria-current, 44 px tab targets, Me (Soon rows, public page, settings, back button, appearance, sign out), the sticky Save bar above the tabs, 404s inside the shell, admin at 390 px. `mobile-pwa.spec.ts`: manifest and icons, viewport and Apple meta tags, `/sw.js` headers, the offline fallback with a registered worker and the cache contents after visiting signed-in pages, the iPhone install card and its "Not now", standalone. `mobile-pages.spec.ts`: every existing page at 360 and 390 px without sideways scroll (`document.scrollingElement.scrollWidth <= innerWidth`, offenders named), 16 px fields, the 44 px hit area, the onboarding walk for both roles with Continue on screen, the role switch changing the tabs, and the data-heavy pages (Connections with a synced YouTube card, `/app/audience` with its country bars, age chart and table view, the public profile) at both widths.
- Helpers for new specs: measure overflow on `document.scrollingElement`; `page.setViewportSize({ width: 360, … })` for small Android phones; `context.setOffline(true)` does reach the service worker; the worker is on in every e2e run (see above); a spec that needs it in control registers it and waits (`navigator.serviceWorker.ready`, then a reload).

**Verification (2026-10-05, this wave)**: unit tests for the manifest, icons, ICO, tabs and Me coverage, title/back rules, install helpers and the worker's caching rules; the whole `mobile` project plus `mobile-desktop.spec.ts`, and the desktop specs most affected by the worker (auth, payouts, fake OAuth, Phase 1 acceptance), passed under `next dev` in an isolated copy (own `.next`, port and database). The desktop run caught the navigation-preload double fetch above. `onboarding-profiles.spec.ts`'s creator test failed there with and without the worker: after the refused "no" handle it waits for `HANDLE_FORMAT_MESSAGE`, which the live check already shows, so the refused submit's form reset can land after the next fill (the race §19.19 fixed in the builder test by waiting for the server's field error, `aria-describedby` with `-error`). Fixed the same way in §19.22.

### 19.21 Database on Supabase (W2): connections, hardening, local stack, launch
The user's "put the DB on Supabase … launch it on localhost", second pass. Guide: `docs/supabase.md`.

**Connections** (`lib/db/connection.ts`; replaces §19.18/§19.19's `databasePoolConfig` CA-only rule and `databaseTls`)
- One resolver for the app, the scripts, the migrations and drizzle-kit: `resolveDatabaseConnection(url, { sslMode, caCert })`. It reads the URL's TLS parameters, **removes them** (`ssl`, `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `sslpassword`, `uselibpqcompat`, `pgbouncer`) and passes an explicit `ssl` (`false`, `{ rejectUnauthorized: false }`, or `{ ca?, rejectUnauthorized: true }`). node-postgres would otherwise let URL parameters override `ssl`, treat `sslmode=require` as verify-full and read `PGSSLMODE`; a unit test runs pg's own `ConnectionParameters` to show nothing overrides ours.
- **`DATABASE_SSL`** (new, beyond §17): `disable | require | verify-full`. (**The URL rules below are superseded by §19.23**: libpq's meaning only on Supabase hosts, node-postgres's elsewhere.) Unset: the URL's `sslmode` with libpq's meaning (`require` = encrypted, server not verified; `verify-ca` → verify-full, stricter; `no-verify` → require; `ssl=true` → verify-full, as node-postgres did; `allow`/`prefer` fall through), then `require` for `*.supabase.co`/`*.supabase.com`, else `disable`.
- **`DATABASE_CA_CERT`** is now PEM text or a file path. A configured CA (or an `sslrootcert` file in the URL) always means verify-full; next to an explicit `disable` it is a configuration error; verify-full on a Supabase host without a CA is a configuration error (Node does not trust Supabase's CA). Client certificates (`sslcert`/`sslkey`) are refused. `lib/env.ts` checks the combination in every environment and names the variable; messages never contain the URL.
- **Production** (supersedes §19.19's rule; **extended to every host and to the scripts by §19.23**): a Supabase host must end up verify-full with a CA. Outside production `require` (unverified) is allowed, which is what the Docker launch against a hosted project uses until `DATABASE_CA_CERT` is set.
- **`DATABASE_POOL_MAX`** (new, default 10, 1–100): the app pool's `max`; scripts use 1.
- `endpoint`: `supabase_direct`, `supabase_session_pooler`, `supabase_transaction_pooler` (port 6543, including the dedicated pooler on `db.<ref>`, or `pgbouncer=true`), `supabase_other`, `postgres`. `getDb()` logs once per process `[db] Supabase (session pooler) at <host>:<port>, database "postgres" (TLS, …)` (never the user or password) and, for a transaction pooler, a one-time warning that session features are unavailable. Checked: app code uses none (only transaction-local `set_config(…, true)`; drizzle sends unnamed statements; drizzle's migrator takes no advisory lock; the only advisory lock is the test template's).
- Scripts take `databaseOptionsFromEnv(process.env)`; `connectScriptDatabase()` (`scripts/lib/script-db.ts`) opens a script's database (used by `admin:grant`; the Phase 2 seed should use it). `drizzle.config.ts` passes host/port/user/password/database plus the explicit `ssl`; the offline commands (`generate`, `check`, `up`, `export`) skip the resolution, so a database setting never blocks `pnpm db:generate`.

**Migrations on Supabase** (`runMigrations`, scripts/lib/db-admin.ts)
- All 9 migrations apply unchanged on Supabase's Postgres (`supabase/postgres:17.11.0.003`, and `17.11.0.002`, which CLI 2.119.0 runs): `postgres` is not a superuser, `CREATE EXTENSION vector` goes through supautils (owner `supabase_admin`, schema `public`), and nothing needs a superuser. No new migration was needed.
- **pgvector's schema:** before migrating, `ensureVectorOnSearchPath` (own connection) checks that the `vector` type resolves. If the extension lives in a schema off the role's search_path (enabled from the dashboard into `extensions`, a role without Supabase's default `"$user", public, extensions`), it runs `ALTER ROLE CURRENT_USER IN DATABASE <db> SET search_path TO <current>, <schema>` (allowed for a non-superuser on itself; tried on the image), so the migrations and the app (same role) resolve `vector(1024)` and `<=>`.
- `pnpm db:migrate` exits 75 while the database is unreachable (`isTransientConnectionError`: ECONNREFUSED, 57P03, …) and 1 otherwise. The Docker entrypoint retries only 75 (2 minutes) and stops at once on a wrong password, a TLS error or a failing migration.

**Post-migrate hardening** (`lib/db/supabase-hardening.ts`, run by `runMigrations` after the migrations: `db:migrate`, `db:reset`, the Docker entrypoint, the integration template and the e2e setup all get it)
- Only where `anon` / `authenticated` exist (`{ applied: false }` on plain Postgres). (**§19.23** adds PUBLIC's grants and default privileges, and a refusal of databases holding another app's objects.) In one transaction: RLS on for every table in `public` and `drizzle` owned by the migrating role; their grants on tables, views, sequences and functions there revoked (and USAGE on `drizzle`) where the grant is ours; the migrating role's default-privilege entries naming them revoked (per schema and global). USAGE on `public` stays (Supabase's own tools expect it; no grant on any object is left).
- Left alone and counted: extension functions granted by their owner (pgvector's 118, granted to the API roles by `supabase_admin`; they read no table). Anything else owned or granted by another role is printed as a WARNING; the run still succeeds. Idempotent; `db:migrate` / `db:reset` print the summary.
- **New tables no longer need `withRLS`** (supersedes §19.18): `rls.test.ts` only checks migration 0007's tables and that no table forces RLS; `supabase-hardening.test.ts` checks every table after the hardening. `withRLS` stays where it is and is harmless on new tables.
- Verified: the integration suite on the Supabase image (`TEST_DATABASE_URL`, 21 files, 223 passed, 2 skipped by design); through Supabase's real Data API (the CLI's gateway and PostgREST with an `anon` JWT) every table answers 42501 and the OpenAPI document lists no table.

**Docker** (`docker-compose.yml`, `launch.sh`, `docker/entrypoint.sh`)
- The `db` service is now `supabase/postgres:17.11.0.003` (database `postgres`, volume `supabase-db`) for parity: the same roles, supautils and default privileges as a hosted project, so the hardening runs locally too. Cost: a larger image (about 1.7 GB) and a slower first start. The old `pgdata` volume is not reused (the image creates its roles only on an empty data directory).
- `DATABASE_URL: ${DATABASE_URL:-postgres://postgres:postgres@db:5432/postgres}` and `DATABASE_SSL` / `DATABASE_CA_CERT` / `DATABASE_POOL_MAX` come from a root `.env` (or the shell, which wins: Compose's rule). `extra_hosts: host.docker.internal:host-gateway` reaches a database on the host (e.g. the CLI's).
- `./launch.sh` (POSIX sh, checked with dash): checks Docker and Compose, prints the database (local, or kind and host:port; never credentials), refuses `localhost` URLs (that is the container), turns a CA file path into the PEM text for the container, prints the app and mailbox URLs, then runs `docker compose up --build`, or `docker compose up --build --no-deps app` for a hosted database (the local one is neither downloaded nor started). Extra arguments go to `docker compose up`.
- Verified in a scratch copy (the sandbox's proxy CA added there only): build, start, migrations and hardening on the Supabase image, a 390 px browser sign-up → dev-mailbox link → role → builder profile, rows in `users` / `sessions` / `events`; and the container against a database on the host through `host.docker.internal`.

**Local Supabase CLI** (`supabase-local/supabase/config.toml`; `pnpm supabase:start | stop | status` = `pnpm dlx supabase@2.119.0 … --workdir supabase-local`, no new dependency)
- Runs the database (54322), Studio (54323) and the gateway and postgres-meta Studio needs. Off: the Data API, auth, storage, realtime, edge runtime, analytics, the mail catcher, the pooler, and the CLI's migrations and seed (Drizzle owns the schema). Verified: start, `pnpm db:migrate`, Studio listing the 42 tables with RLS, status, stop.
- The CLI publishes its ports on all interfaces (no setting restricts it) with the password `postgres`: documented as trusted-network only. It collides on 54322 with the `supabase-db` container of §19.18/§19.19 (`docker stop supabase-db`); this pass left that container and the user's `pnpm dev` on port 3000 running.

**Open**
- No hosted Supabase project was available: the Supavisor session/transaction poolers and the `prod-ca-2021` chain follow Supabase's docs and were not tried. The TLS modes were checked end to end against a local Postgres with TLS on (require; verify-full with the CA as a path and as PEM; verify-full failing without the CA and on a host mismatch).
- CI's `supabase-postgres` job still checks table grants and RLS with psql (it now also prints the hardening summary through `pnpm db:migrate`); `ci.yml` was outside this task.

### 19.22 Supabase + mobile app gate (W2): findings and fixes
The integration gate for §19.20 and §19.21. Decisions and fixes:

**`next dev` memory** (`next.config.ts`)
- `experimental.turbopackMemoryEviction: "full"`. With the persistent dev cache, Turbopack's default `"auto"` eviction waits for memory pressure on the whole machine; inside a container or runner with a lower memory limit (this sandbox: a 13.4 GB cgroup on a 16 GB host) a dev server that opens ~30 routes grew to 11–12 GB and was OOM-killed. The full e2e suite under `next dev` died that way at the start of the `mobile` project (twice), and so did the mobile builder's runs (§19.20). Measured: 34 routes in a row as a signed-in user, peak 12.2 GB with `"auto"`, 4.5 GB with `"full"`; the whole e2e suite under `next dev` now peaks at 4.4 GB. `"full"` drops the in-memory copies after each snapshot to `.next/dev` and reloads them from disk on demand; Next documents it as affecting `next dev` only.

**E2E isolation**
- Fake provider fixtures are shared by specs: `phase1-acceptance.spec.ts` and `mobile-pages.spec.ts` both connect YouTube's "Ada Codes", and one platform user per provider account (§19.11) made whichever ran second end on `?error=account_in_use` in a full run (the builders ran them in separate batches). `releaseSocialAccount(provider, providerAccountId)` (`tests/e2e/helpers/db.ts`, with `ADA_CODES_CHANNEL_ID`) deletes the earlier connection the way a disconnect does (GDPR erasure hatch, so its snapshots go too). **A spec that connects a fixture account releases it first.**
- `onboarding-profiles.spec.ts` creator test: after the refused "no" handle it now waits for the server's field error (`aria-describedby` with `-error`), like the builder test.

**Docker against a shared hosted database**
- `docker-compose.yml` passes `AUTH_SECRET` and `ENCRYPTION_KEY` from `.env` (empty, the default, still means "generated once and kept in the appdata volume"; `docker/entrypoint.sh` treats empty as unset). When `./launch.sh` and `pnpm dev` use the same Supabase project, both must encrypt OAuth tokens with the same key (§4), otherwise one app cannot read the tokens the other stored. Documented in docs/supabase.md and docker/README.md.
- `launch.sh` names the local volume after `COMPOSE_PROJECT_NAME` (shell or `.env`), which Compose uses for it.

**Installing the app (docs)**
- README "Install it on a computer or a phone" (pointed to from docker/README.md and docs/supabase.md). Service workers and installation need a secure origin (https, or `localhost` on the device), so the options are: this computer at `http://localhost:3000`; an Android phone over USB with `adb reverse tcp:3000 tcp:3000` (works with Docker's loopback-only port, nothing exposed); any phone, iPhone included, over https through a tunnel (Tailscale Serve preferred because it is private; a public tunnel needs `DEV_MAILBOX` unset and the code read from `.data/outbox/`), using `pnpm build && pnpm start` with `APP_ENV=development` and `NEXT_PUBLIC_APP_URL` / `AUTH_URL` set to the tunnel's address (Docker's address is fixed at `http://localhost:3000`); plain http on the same Wi-Fi works in the browser but without the service worker or Chrome's Install (an iPhone can still Add to Home Screen). None of this was tried on a physical device (none here).

**Gate results (2026-10-05)**
- CI on the PR head (`77435f7`): green (both jobs, "Typecheck, lint, test, e2e" and "Migrations and integration tests on Supabase Postgres", on both workflow runs).
- Locally: typecheck, lint, format, unit + integration (76 files, 870 tests), build, and e2e under `next dev` and under `CI=1` (build + start): 31/31 each (desktop project 19, `mobile` project 12).
- Supabase end to end: a fresh `supabase/postgres:17.11.0.003` container; `pnpm db:migrate` applied every migration and the hardening (43 of 43 tables with RLS, no `anon` / `authenticated` table grants; a second run changes nothing); `pnpm db:seed` (still the Phase 2 placeholder); `pnpm build` and `pnpm start` with `APP_ENV=development`, `FAKE_SERVICES=all` on that database. Walk on an iPhone 13 viewport: landing, sign-in, sign-up through the outbox link, role, creator profile, fake YouTube connect and sync (48.2K), AI review, fake Stripe payouts, `/app` with tabs Home · Audience · Profile · Payouts · Me, the install card and the iPhone steps sheet, `/app/audience`, Me, `/c/<handle>`, and dark mode; no sideways scroll at 390 px, no console errors. Rows landed in `users`, `sessions`, `creator_profiles`, `social_connections` (tokens as `v1:` ciphertext), `audience_snapshots`, `stripe_accounts` and `events` (14, no email or token in any property). `SET ROLE anon` / `authenticated`: permission denied for `users`, `social_connections` and `events` (read and insert).
- Docker (in a scratch copy, the sandbox proxy's CA added there only): zero config (`./launch.sh -d`, no `.env`) built the image, started Supabase's Postgres, ran migrations and hardening, and the same walk passed through the dev mailbox; `anon` denied. With `DATABASE_URL` in `.env` pointing at the Supabase instance above (through `host.docker.internal`), `launch.sh` started only the app, the migrations were a no-op, and the walk passed (after the earlier walk's YouTube fixture was released: the app answered `account_in_use` as it should).

### 19.23 Supabase + mobile app (W2): review findings
Fixes for the W2 review. Each has a test that fails without it (checked by reverting the fix).

**Database TLS** (`lib/db/connection.ts`; supersedes the URL rules of §19.21)
- **The URL keeps node-postgres's meaning on every host but Supabase's**, so no URL that verified before the resolver existed got weaker: `sslmode=require`, `prefer`, `allow`, `verify-ca`, `verify-full`, `ssl=true` and a lone `sslnegotiation=direct` verify the server (Neon's default `?sslmode=require&channel_binding=require` stays verified); `no-verify`, `ssl=no-verify` and, with `uselibpqcompat=true`, libpq's `prefer` / `require` encrypt without verifying. On Supabase hosts (`*.supabase.co`, `*.supabase.com`, also with a trailing dot) the URL keeps libpq's meaning (`require`, `prefer`, `allow`, `no-verify` encrypt without verifying), because Node does not trust Supabase's CA. `ssl=false` / `ssl=0` mean plain text (node-postgres kept the string `"false"`, which is truthy, and used TLS by accident). A unit test compares the resolver with node-postgres's own parsing over every combination of `sslmode` × `ssl` × `uselibpqcompat` × `sslnegotiation` × `sslrootcert` and fails when ours is weaker.
- Unknown `sslmode`, `ssl` (e.g. `ssl=require`) and `sslnegotiation` values are configuration errors, never ignored.
- **`sslnegotiation`** is removed from the URL and passed to node-postgres as its own option (`pgConnectionConfig(connection)`: `connectionString`, `ssl`, `sslnegotiation`, always explicit, so neither the URL nor `PGSSLMODE` / `PGSSLNEGOTIATION` change them). pg-connection-string turned a lone `sslnegotiation=direct` into `ssl: true`, replacing our `ssl` (and `DATABASE_CA_CERT`). `direct` next to TLS off is a configuration error. drizzle-kit takes no `sslnegotiation`; it negotiates the usual way (still TLS).
- **Production rule for every host** (`productionTlsProblem`, applied by `resolveDatabaseConnection(url, { production: true })`): a database on this machine (`localhost`, `*.localhost`, 127.0.0.0/8, `::1`, a Unix socket) passes; a Supabase host must be verified against `DATABASE_CA_CERT` / `sslrootcert` (as before); **any other host must be encrypted and verified, unless `DATABASE_SSL=require` accepts an unverified server on purpose** (a private network, a CA the app is not given). An empty host is not local (node-postgres would take `PGHOST`). `PGSSLMODE` stays ignored: a deployment that relied on it now fails at boot with a message naming `DATABASE_URL` / `DATABASE_SSL`, never silently.
- **The scripts apply it too**: `databaseOptionsFromEnv(process.env)` returns `production` from `isStrictProductionEnv` (`lib/app-env.ts`: `APP_ENV`, else `NODE_ENV`, never during `next build`; `lib/env.ts` uses the same `resolveAppEnv`), and `pnpm db:migrate`, `db:reset`, `admin:grant` (`connectScriptDatabase`) and drizzle-kit pass it. Docker and e2e (`NODE_ENV=production` with a non-production `APP_ENV`) are unaffected.

**Supabase hardening** (`lib/db/supabase-hardening.ts`)
- **PUBLIC counts.** The grant queries include the PUBLIC pseudo-role (grantee 0), and a function's NULL ACL is read as PostgreSQL's default (`acldefault`, which gives PUBLIC EXECUTE). The hardening revokes PUBLIC's grants on tables, views, sequences and functions we own in `public` / `drizzle` (extension functions keep theirs and are counted as "left alone"; trigger functions are safe to revoke, EXECUTE is only checked when a trigger is created), clears default-privilege entries that grant PUBLIC new tables, sequences or functions, and revokes PostgreSQL's built-in EXECUTE for PUBLIC on new functions globally for the migrating role (`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`; per-schema entries cannot remove a global default). That global setting is per database, so in the platform's own project every function created later by `postgres` (a migration, the SQL editor) starts without PUBLIC EXECUTE. `remaining.grants` lists PUBLIC grants it could not revoke and the default if still granted. Verified on the `supabase-db` container: before, `has_function_privilege('anon', 'public.append_only_guard()', 'EXECUTE')` was true and the ACL `{=X/postgres,…}`; after `pnpm db:migrate`, false, and a new `SECURITY DEFINER` function is not executable by `anon`; a second run changes nothing.
- **Only the platform's own database is migrated and hardened.** Before migrating, `runMigrations` checks ownership (`foreignObjects`): the database is the platform's when drizzle's journal (`drizzle.__drizzle_migrations`) records one of our migrations (hashes from `readMigrationFiles`); otherwise every table, view, sequence (not one owned by a column) and routine in `public` outside extensions, and journal entries of another Drizzle app, are someone else's. If there are any, it throws `ForeignDatabaseError` (exit 1, before the pgvector search_path fix or anything else changes) naming up to 10 of them, unless **`DATABASE_ALLOW_FOREIGN_OBJECTS=1`** (new, beyond §17; `pnpm db:migrate` and Docker Compose pass it) says to migrate it anyway. An empty database (a fresh Supabase project, the test template, the e2e database) and a restored dump (its journal comes along) pass. Restricting the hardening to the platform's schema objects instead was rejected: a later phase's SQL function in `public` would then be skipped and left executable.
- `./launch.sh` says whether `DATABASE_URL` comes from the shell (which wins over `.env`) and, when run from a terminal, asks before using a shell one; non-interactive runs go on (the check above protects other apps' databases).

**Service worker** (`public/sw.js`, `VERSION` v2)
- The offline page and every file it needs (scripts, CSS, fonts) plus the icons are one **snapshot in the offline cache, which is never trimmed**; cache-first requests look there first, then in the static cache (trimmed to 250, oldest first). Before, the offline page's files were the oldest entries of the static cache and the first to be trimmed, and they could not be fetched again once a deploy removed them.
- The snapshot is **renewed in place at most once a day**, after a navigation that reached the network: the new page's files are stored first, the page last (stamped `X-SW-Precached-At` on the stored copy), then files of the previous snapshot are deleted; a failed renewal keeps the old snapshot. So a changed offline page no longer needs a `VERSION` bump (and a build ID route for `sw.js`, the review's alternative, was not needed: the snapshot is self-consistent whatever the server holds).
- **Update prompt:** `watchForUpdates` (`lib/pwa/sw-update.ts`) also follows a worker that is already **installing** when the page starts watching (the browser's own navigation check can find it before hydration), besides one already waiting and one found later.

**Phone layout**
- **Theme colour:** `ThemeColorSync` is mounted once in the root layout (sign-in, onboarding and public profiles had none) and re-applies the chosen colour whenever Next rewrites the `theme-color` tags on a client-side navigation (MutationObserver on `<head>`, writing only when the value differs).
- **Toasts:** the Toaster also gets `offset.bottom = 24px + --sticky-bottom`; sonner's `mobileOffset` applies only up to 600 px, the tab bar up to 767 px.
- **Focused fields clear the Save bar:** `FormActions` carries `data-form-actions` and measures its height into `--form-actions-height` (ResizeObserver; the tallest mounted bar); below `sm` it is added to the root's `scroll-padding-bottom` (5rem before the first measurement).
- **Safe areas around the sidebar:** the mobile sidebar sheet (the admin menu) pads by the top, bottom and side insets; the desktop sidebar grows by the inset on its side (`--sidebar-inset`) and pads its content by it and by the bottom inset, so a phone in landscape (which gets the desktop layout from 768 px) clips nothing; the desktop header uses `px-safe-4`. Tested with Chromium's safe-area emulation (`Emulation.setSafeAreaInsetsOverride`, Chromium 141).
- **Install on iOS:** `iosBrowser()` tells Safari, Chrome (`CriOS`), other browsers (`FxiOS`, `EdgiOS`, …) and **apps' built-in browsers** apart (Instagram, Facebook, TikTok, LinkedIn, LINE, Snapchat, Pinterest, X, the Google app, WeChat, or any iOS web view without a `Safari/` token). Built-in browsers get no install card, and Me says "Open this page in Safari to install"; Chrome's steps say "Share in the address bar"; others "your browser's menu". (`InstallMethod` gained `in_app`.)

**Tests added or changed:** `tests/unit/db/connection.test.ts` (pg comparison, Neon, Supabase libpq meaning, unknown values, sslnegotiation through pg's ConnectionParameters with `PGSSLNEGOTIATION` set, trailing-dot hosts, loopback hosts, `productionTlsProblem`, `production` option), `tests/unit/env.test.ts` (non-Supabase production rules, unknown TLS values), `tests/unit/db/db-admin.test.ts` (`runMigrations` and `connectScriptDatabase` refuse in production), `tests/unit/db/supabase-hardening.test.ts`, `tests/integration/db/supabase-hardening.test.ts` (PUBLIC on functions and tables, a later `SECURITY DEFINER` function not executable by anon, the built-in default revoked), `tests/integration/db/foreign-database.test.ts` (new: refused untouched, allowed with the flag, another Drizzle app's journal, empty databases), `tests/unit/service-worker.test.ts` (snapshot survives trimming and works offline, daily renewal in place, failed renewal keeps the snapshot), `tests/unit/sw-update.test.ts` (new), `tests/unit/pwa.test.ts` (iOS browsers, wording), `tests/e2e/mobile-layout.spec.ts` (new, `mobile` project: theme colour across tab taps and on sign-in and public profiles, a toast above the tab bar at 744 px, tabbing through the profile form at 360×640, the admin menu and the landscape layout with emulated insets, Instagram's and Chrome's iPhone install wording), `tests/e2e/mobile-pwa.spec.ts` (the offline cache holds every file its page references).
- The integration helper `createEmptyTestDatabase()` (`tests/helpers/db.ts`) makes an empty database named like the run's clones, so the sweeps drop it if a file crashes.


**Gate results (2026-10-05, this pass):** typecheck, lint, format, unit + integration (78 files, 899 tests), build, e2e under `next dev` and under `CI=1` (build + start): 37/37 each (desktop 19, `mobile` 18). The integration project on the `supabase/postgres:17.11.0.003` container: 22 files, 228 passed, 2 skipped by design. `pnpm db:migrate` on the `supabase-db` container (the user's dev database) revoked PUBLIC from the two guard functions and the built-in default; a second run changed nothing. The user's `pnpm dev` on port 3000 (another `next dev` in the same directory blocks e2e under `next dev`) was stopped for the e2e runs and started again afterwards.

### 19.24 W2 contracts: Phases 2–3 groundwork (schema, registries, cross-area interfaces)
Written before the four Phase 2–3 builders start, two at a time: **supply** ∥ **proposals**, then **matching** ∥ **collab**. Builders do not change the schema; this section is the interface between them. Areas: supply = ideas, products, embeddings; matching = discover, match scoring, seed, `/app` home; proposals = proposals, threads, messages, notifications pages; collab = collabs, agreements, tasks, reminders.

**Shared files (who may edit what)**
- Frozen for builders: `lib/db/schema/**`, `drizzle/**`, `lib/events/types.ts`, `lib/notifications/types.ts`, `inngest/client.ts`, `inngest/functions/index.ts`, `lib/auth/authz.ts`, `lib/markdown.ts`, `tests/helpers/db-fixtures.ts`. A builder who needs a change there stops and reports it instead.
- Each builder replaces only its own stubs: job handler files (`inngest/functions/<job>.ts`), `lib/seed/<step>.ts`, `components/proposals/home-section.tsx` / `components/collabs/home-section.tsx`, `lib/collabs/create.ts` (collab). Delete the stub helper `inngest/functions/not-implemented.ts` once nothing imports it.
- `lib/nav.ts`: each builder adds its pages to its own list only (`SUPPLY_ROUTES`, `DISCOVER_ROUTES`, `PROPOSALS_ROUTES`, `COLLAB_ROUTES`) when the page exists; tabs, Me, menus, home cards and manifest shortcuts follow by themselves (§19.19, §19.20). No other nav change is needed for §12's Phase 2–3 routes: `/app/ideas`, `/app/products`, the discover pages, `/app/proposals`, `/app/collabs`, `/app/messages` and `/app/notifications` are already menu items; `…/new`, `…/[id]` and the collab sub-pages are reached from their parent pages.
- `CLAUDE.md`: each builder writes only its own pre-numbered subsection: §19.25 supply, §19.26 proposals, §19.27 matching, §19.28 collab.
- Tests: area fixtures go in `tests/integration/<area>/helpers.ts` and `tests/e2e/helpers/<area>.ts`; e2e specs `tests/e2e/<area>*.spec.ts`, phone checks `tests/e2e/mobile-<area>.spec.ts` (the `mobile` project). A spec that connects a fake social fixture account releases it first (§19.22).
- `app/app/page.tsx` belongs to matching, which keeps rendering `ProposalsHomeSection` and `CollabsHomeSection` (`{ userId, role }`, server components; render nothing when empty). `app/app/layout.tsx` belongs to proposals (passes `unreadNotifications` / `unreadMessages` to `AppShell`).

**Schema (migration `0009_w2_supply_collab`, generated; integration tests in `tests/integration/db/w2-constraints.test.ts`)**
- Every 0009 table was empty in every environment, so its `NOT NULL` columns without defaults (`proposal_revisions.revision_number`, `agreements.rendered_body`, `agreement_signatures.body_hash`) and the `ended_reason` text → enum change needed no backfill. It runs on Supabase's Postgres unchanged (built-in `sha256()`, no extension, no superuser); the post-migrate hardening covers it.
- `ideas` / `products`: `published_at` (required while open/seeking/in_collab/launched), `archived_at` (set exactly while archived), non-blank title, lowercase currency, `products.demo_url` http(s) only, index `(status, published_at desc)`.
- `creator_profiles`, `builder_profiles`, `ideas`, `products`: `embedding_text_hash` (sha256 hex of the embedded text) and `embedded_at`.
- `matches`: `stale_at` (null = in the subject's current list), `shown_at` (first shown), CHECK `matches_features_vector` (exactly the seven §8 keys, each a number in 0–1), CHECK `matches_not_self`, indexes for the current list and by target; `saved_items` index by target.
- `proposals`: `match_id` (FK, `ON DELETE SET NULL`), `responded_at` (first answer by the recipient), `closed_at` (set exactly for accepted/declined/expired/withdrawn), unique index `proposals_one_open_per_pair_target_idx` (one pending/countered proposal per pair of people and idea/product, either direction). `created_at` is the sent time (there are no draft proposals; no separate `sent_at`).
- `proposal_revisions.revision_number` (1, 2, …; unique per proposal) and a non-blank scope.
- `collabs`: `stage_changed_at`, `last_activity_at` (both default to the app clock), `ended_at`; `ended_reason` is now the enum `collab_end_reason` (`completed | cancelled | dispute | admin`); `stage = ended` ⇔ `ended_at` and `ended_reason` set.
- `agreements`: `rendered_body` (the exact text signed; the database checks `body_hash = sha256(rendered_body)`), `completed_at` (set when status is `signed`, never while awaiting), `terminated_at` (set exactly when terminated), `pdf_storage_key` only after completion, `template_version` like `v1`. The generation time is `created_at`.
- `agreement_signatures.body_hash` (the hash the party signed) and a non-blank typed name.
- `tasks`: `description`, `created_by_user_id`, `completed_by_user_id` (only when done), non-blank title, position ≥ 0.
- `threads.last_message_at`; `thread_reads.last_read_at` is nullable (null = never opened); `messages` need a non-blank body and an attachments array; `notifications` payload must be an object, plus a partial index for unread in-app rows. "Non-blank" is `~ '[^[:space:]]'` everywhere.

**Registries (filled now; owners implement)**
- Events added beyond §11: `idea.updated { fields }`, `idea.restored`, `product.updated { fields }`, `product.restored`, `match.unsaved`, `task.created { collab_id, assigned }`, `task.reopened { collab_id }`; `collab.ended` gained `reason`.
- Notification types (`lib/notifications/types.ts`: a Zod payload schema per type in `NOTIFICATION_PAYLOAD_SCHEMAS`, `NOTIFICATION_TYPE_LABELS`, `NOTIFICATION_GROUPS` for the settings page, `NOTIFICATION_LINKS` as functions of the payload, `parseNotification` / `notificationHref` for lists). `notify()` now validates the payload against its type's schema. Proposals: `proposal.received | countered | accepted | declined | withdrawn | expired` (payload `proposal_id`, `counterpart_name`, `target_kind`, `target_title`; `revision_number` on countered, `collab_id` on accepted). Collab: `agreement.ready | signed | completed | reminder`, `collab.stalled`, `task.assigned`.
- Email templates (`lib/email/templates/`): proposals owns `proposal-received.tsx`, `proposal-countered.tsx`, `proposal-accepted.tsx`; collab owns `agreement-ready.tsx`, `agreement-completed.tsx` (PDF attached). Every other type uses `notification.tsx`. Links via `absoluteUrl(NOTIFICATION_LINKS[type](payload))`.
- Jobs (registered with no-op handlers returning `{ skipped: true, reason: "not_implemented" }`; run one with `POST /api/test/jobs/<id>`):

| Job id | Event | Trigger | Owner |
|---|---|---|---|
| `embeddings-refresh` | `embeddings/refresh.requested { subjectType, subjectId }` | `requestEmbeddingRefresh()`; debounced 10 min per entity | supply |
| `matching-recompute` | `matching/recompute.requested { userId, reason }` | `requestMatchingRecompute()`; debounced 10 min per user | matching |
| `matching-target-changed` | `matching/target-changed.requested { targetType, targetId }` | `requestTargetRescore()`; debounced 10 min per target | matching |
| `matching-nightly` | `matching/nightly.requested {}` | cron 05:30 UTC (after the 04:15 social sync) | matching |
| `proposals-expire` | `proposals/expire.requested {}` | cron hourly at :05 | proposals |
| `reminders-stalled` | `reminders/stalled.requested {}` | cron 08:50 UTC | collab |
| `agreements-finalize` | `agreements/finalize.requested { agreementId }` | after the last signature commits | collab |

- `matching/recompute.requested.userId` became required (a whole-population run is `matching-nightly`).
- Rate limits: proposals use `RATE_LIMITS.proposals` (new proposals only, 20/day per user; counters are not limited), messages `RATE_LIMITS.messages`; area-specific buckets are passed with their rule at the call site (`rateLimit("idea-brief", userId, { limit: 10, window: "1 h" })`, `message-attachment-upload` 20/h), so `lib/ratelimit.ts` needs no edit.
- Authorization (`lib/auth/authz.ts`, unit-tested): `canCreateIdea`, `canManageIdea`, `canViewIdea`, `canCreateProduct`, `canManageProduct`, `canViewProduct` (others see `PUBLIC_IDEA_STATUSES` / `PUBLIC_PRODUCT_STATUSES` only), `canDiscover(user, role)`, `canActOnMatch`, `canSendProposal(user, { target, recipient })`, `canViewProposal`, `canRespondToProposal`, `canWithdrawProposal`, `canViewCollab`, `canWorkInCollab`, `canSignAgreement`, `canViewThread`, `canPostMessage`. Admins read; they never act as a party.

**User Markdown** (`lib/markdown.ts`, written by this prep because supply and proposals both need it): `renderMarkdown(source)` → sanitized HTML (§14): marked (GFM, line breaks kept) then sanitize-html; no raw HTML, no images, headings demoted to h3/h4, links http(s)/mailto only with `target="_blank" rel="nofollow noopener noreferrer"`. Product descriptions, idea problems/evidence and messages render through it (`dangerouslySetInnerHTML` on its output only).

**Ideas and products** (supply)
- Idea: `draft →publish→ open`; `draft | open →archive→ archived`; `archived →restore→ draft`; `open → in_collab` only through `createCollabFromProposal`; `in_collab → launched` (Phase 4) and `in_collab → open` when a collab ends before launch (Phase 6). Products the same with `seeking`. Publishing sets `published_at`; archiving sets `archived_at`, restoring clears it. Owners edit in draft and open/seeking only. Events: `.created` (also when created and published at once, then `.published` too), `.updated { fields }`, `.published`, `.archived { from_status }`, `.restored`.
- **Exclusivity** (decided here): an accepted proposal moves an exclusive product to `in_collab`; a non-exclusive one stays `seeking` and may collab with several creators. Ideas always move to `in_collab` (built once).
- Archiving with open proposals is allowed; those proposals can no longer be accepted (plain error) and expire, or are withdrawn/declined.
- Titles (ideas, products, tasks) stay ≤ 200 characters and display names ≤ 120: notification payloads cap them (`notify()` refuses longer ones).
- After every committed change that matters for matching, call `requestEmbeddingRefresh({ type: "idea" | "product" | "creator_profile" | "builder_profile", id })` (lib/embeddings/request.ts) **after the commit**.

**Embeddings** (supply, `lib/embeddings/**`, job `embeddings-refresh`)
- Text per entity: creator profile `creatorProfileEmbeddingText` (lib/social/derived.ts), builder profile `builderProfileEmbeddingText` (lib/profiles/embedding.ts), idea: title, problem, audience evidence, format label, topics; product: title, description, target user, stage, format label, topics. Never names, handles or emails.
- The job composes the text, skips the API call when `sha256(text)` equals `embedding_text_hash` and `embedding_model` is the current model, else embeds (`embed`, kind `document`) and writes `embedding`, `embedding_model`, `embedding_text_hash`, `embedded_at`. Then, embedded or not (status and other features may have changed): ideas/products → `requestTargetRescore({ targetType, targetId })` and `requestMatchingRecompute({ userId: owner, reason: "idea_changed" | "product_changed" })`; profiles → `requestMatchingRecompute({ userId, reason: "profile_changed" })` and `requestTargetRescore({ targetType: "creator" | "builder", targetId: userId })`. An embedding failure is reported and keeps the old vector.
- Supply switches Phase 1's direct refreshes (profile saves and portfolio changes in lib/profiles, syncs and summaries in lib/social) to `requestEmbeddingRefresh`; those call sites are the only Phase 1 code it edits.

**Matching** (matching, `lib/matching/**`)
- Subjects and candidates (§8): a creator sees `seeking` products (target `product`) and builders with `availability <> 'closed'` (target `builder`); a builder sees `open` ideas (`idea`) and creators with a verified connection (`creator`: `social_connections.status = 'active' AND verified_at IS NOT NULL`). Everyone involved is `users.status = 'active'` with `onboarding_completed_at` set and the relevant profile; never yourself; never a target the subject dismissed under any model version. `target_id` is the user id for `creator` / `builder` targets.
- Inputs: profiles' `embedding`, `topics` (creators), `skills` / `stack` (builders), `languages`, `country`, `size_tier`; the latest snapshot's `top_countries`; `portfolio_items.format` / `is_shipped`; ideas' and products' `embedding`, `topics`, `format`, `stage`, `target_price_cents`, `currency`; reliability from `collab_members` ⨝ `collabs` (`live`, or ended `completed` ↑) and `disputes` against the user ↓. Unknown inputs give the neutral 0.5.
- Rows: `features` exactly `{ semantic, topic_overlap, audience_fit, format_fit, stage_fit, price_fit, reliability }` (the database checks it), `score` = Σ active `matching_config.weights` × features (0–1), `model_version` = the active config's (`v0`), `computed_at`. A recompute upserts the subject's top 30 (`ON CONFLICT` on the unique key: score, features, `computed_at`, `stale_at = null`; never the status) and sets `stale_at` on the subject's other current rows. Rows are never deleted (v1 training data). Lists: `stale_at IS NULL AND status IN ('shown', 'saved')` by score. One `match.computed` per subject per run.
- Statuses: Save → `saved` + `saved_items` upsert + `match.saved`; unsave → `shown` + delete + `match.unsaved`; dismiss → `dismissed` + `match.dismissed`; `proposed` is set by proposals when a proposal is sent with `match_id`. `match.shown` once per row (conditional `shown_at` update); `match.clicked` when a card is opened.
- Explanation: prompt `match_explanation@v1` (lib/ai/prompts/match-explanation.ts, with `fake`) names the top two contributing features (weight × value); cached in `explanation` + `explanation_prompt_version` after the recompute transaction, regenerated only when the top two change; until then pages show a deterministic sentence from the same two features (never block on the LLM). `ai.generated` with subject `match`.
- Discover links to proposals as `/app/proposals/new?to=<userId>&idea=<id>|&product=<id>&match=<matchId>`.

**Proposals** (proposals, `lib/proposals/**`)
- States: `pending` and `countered` are open; `accepted`, `declined`, `expired`, `withdrawn` are final (`closed_at` set). The party who did **not** author the current revision answers: accept, counter or decline. The current revision's author may withdraw. `proposals/expire` expires open ones past `expires_at`.

| Action | Who | Status after | Event | Notification (to) |
|---|---|---|---|---|
| send | sender (`canSendProposal`) | pending | `proposal.sent` | `proposal.received` (recipient) |
| counter | awaiting party | countered | `proposal.countered` | `proposal.countered` (other party) |
| accept | awaiting party | accepted | `proposal.accepted` (+ `collab.created`) | `proposal.accepted` (other party) |
| decline | awaiting party | declined | `proposal.declined` | `proposal.declined` (other party) |
| withdraw | current offer's author | withdrawn | `proposal.withdrawn` | `proposal.withdrawn` (other party) |
| expire | job | expired | `proposal.expired` | `proposal.expired` (both) |

- Send, one transaction: proposal + revision 1 + `current_revision_id` + `createThread(tx, { kind: "proposal", … })` + `proposal.sent` (+ the match → `proposed` when `match_id` belongs to the sender and the same target) + notify. Before it: the `proposals` rate limit; after a 23505 on `proposals_one_open_per_pair_target_idx`: "You already have an open proposal with them about this." `/app/proposals/new?to=<userId>` without a target lets the sender pick one of their own open ideas (creator) or seeking products (builder).
- Revisions are append-only: a counter inserts revision n + 1 (splits sum to 100, checked by the database; `timeline_weeks` > 0), moves `current_revision_id`, sets `expires_at = now + 14 days` (every counter resets it), and `responded_at` on the first answer. Accepting accepts the current revision's terms.
- Acceptance: lock the proposal, set `accepted` + `closed_at` (+ `responded_at`), call `createCollabFromProposal(proposal.id, tx, { actorUserId })`, then track `proposal.accepted` with its `collab_id` and notify, all in one transaction.
- Every transition is a conditional update on the expected status (`WHERE status IN ('pending', 'countered')`), so a racing answer, withdrawal or expiry loses cleanly.

**Acceptance → collab** (`lib/collabs/create.ts`, owned by collab, called by proposals)
- `createCollabFromProposal(proposalId: string, tx: Tx, options: { actorUserId: string }): Promise<{ collabId, threadId, created, agreementId }>`. Already working (W2 prep): idempotent; checks and moves the target (idea `open → in_collab`, exclusive product `seeking → in_collab`, else an `ActionError` that rolls the acceptance back); inserts the collab (`agreement`), both members (idea owner = creator, product owner = builder; splits from the current revision), the collab thread and `collab.created`. **Collab adds** agreement generation inside it (`agreement.generated`, notify `agreement.ready` to both) and returns `agreementId`; the signature stays.

**Threads and messages** (proposals, `lib/threads/**`, `lib/messages/**`)
- One thread per proposal (created at send) and one per collab (created with it). `createThread(tx, input)` (lib/threads/create.ts, working) inserts a `thread_reads` row per participant (`last_read_at` null), so a user's inbox is `thread_reads WHERE user_id = me` and needs no union over proposals and collabs. Authorization still comes from the parent (`canViewThread` / `canPostMessage`).
- Posting: rate limit `messages`; insert the message; `threads.last_message_at` and the author's `last_read_at` = the message's `created_at`; for collab threads `touchCollabActivity(tx, collabId)`; `message.sent { thread_kind, attachment_count }` (never the body). No notification per message: unread messages show in the Inbox badge and `/app/messages`. Bodies are Markdown (≤ 5,000 characters) rendered only through `renderMarkdown` (below). Attachments: the attachment purpose (25 MB, §19.7), uploaded to `message-uploads/<userId>/<uuidv7>.<ext>` and copied on send to `message-attachments/<threadId>/<uuidv7>.<ext>` (the §19.19 pattern).
- Opening a thread sets `last_read_at` to its newest message's `created_at`.
- Shell counts (proposals wires `app/app/layout.tsx`): `unreadNotifications` = in-app rows with `read_at IS NULL AND in_app` (partial index); `unreadMessages` = messages by others in the user's threads newer than `coalesce(last_read_at, '-infinity')`.
- Notifications page: in-app rows newest first, `parseNotification` (skip nulls), links with `notificationHref`, mark read on open and "Mark all as read".

**Collabs, agreements and tasks** (collab)
- Stages: `changeCollabStage(tx, { collabId, from, to, actorUserId, endedReason? })` (lib/collabs/stage.ts, working) is the only way to change a stage: a conditional update (`CollabStageConflictError` when the collab moved on), `stage_changed_at`, `last_activity_at`, the ended columns, `collab.stage_changed` and `collab.ended { from_stage, reason }`. Allowed: `agreement → building`, `building → launch_review`, `launch_review → live | building`, any open stage `→ ended`; Phases 4 and 6 extend `COLLAB_STAGE_TRANSITIONS`.
- Activity: `touchCollabActivity(db, collabId, at?)` (lib/collabs/activity.ts, working; never moves backwards) after messages, task changes, signatures; stage changes set it themselves.
- Agreement: template `lib/agreements/template-v1.tsx`, `template_version = 'v1'`, `terms` = `AgreementTerms` (parties with name, role and split from `collab_members`; scope and timeline from the accepted revision; IP, term and exit from the template), `rendered_body` = the rendered plain text, `body_hash` = its sha256. Signing (`canSignAgreement`, a typed full name, **both** members payouts-ready per `isPayoutsReady`, else a plain message naming who still has to set up payouts): insert the signature with the agreement's `body_hash`, IP and user agent, `agreement.signed { role }`, `touchCollabActivity`, notify `agreement.signed` to a member who has not signed. The last signature also sets `status = signed`, `completed_at`, `agreement.completed`, `changeCollabStage(agreement → building)`, and enqueues `agreements/finalize` after the commit (PDF at `agreements/<collabId>/<agreementId>.pdf`, then `pdf_storage_key`, then `agreement.completed` to both with the PDF attached; dedupe keys `agreement.completed:<agreementId>:<userId>`).
- `/legal/agreement` renders template v1 with placeholder terms.
- Tasks: members create (title ≤ 200, optional description, assignee = a member or nobody, due date), complete / reopen, reorder (`position`); events `task.created`, `task.completed { on_time }` (due date ≥ the completion day in UTC; null without a due date), `task.reopened`; `task.assigned` to an assignee other than the actor; each touches the collab's activity.
- Reminders (`reminders-stalled`): `collab.stalled` for collabs in `agreement` or `building` idle for 7+ days (dedupe `collab.stalled:<collabId>:<last_activity_at ms>`), `agreement.reminder` to each member who has not signed an agreement created 3+ days ago (dedupe `agreement.reminder:<agreementId>:<userId>`).

**Seed** (`pnpm db:seed` → `lib/seed/index.ts`)
- Steps in order, one file each: `people`, `supply`, `matches` (matching), `collabs` (collab); Phase 4 adds `launches`. Idempotent (Docker seeds on every start): seeded users have the fixed emails `seed-creator-01@example.com` … `-10` and `seed-builder-01@example.com` … `-10`, and steps skip what exists. Steps write through the app's own functions where they exist (events and checks hold), take times from `ctx.now`, and the script refuses `APP_ENV=production`. The e2e global setup runs it on the e2e database before every run.

**Tests written by this prep:** `tests/integration/db/w2-constraints.test.ts` (every new CHECK, unique and default), `tests/integration/contracts/w2-contracts.test.ts` (`createCollabFromProposal`, `createThread`, `touchCollabActivity`, `changeCollabStage`, the request helpers), `tests/unit/auth/authz.test.ts` (the new rules; `canSendProposal` in both directions), `tests/unit/notifications/types.test.ts` (a sample payload per type, labels, groups, links, parsing), `tests/unit/jobs.test.ts` (job ids, events and schedules), `tests/unit/events/types.test.ts`, `tests/unit/markdown.test.ts`. Shared fixtures added: `insertIdea` / `insertProduct` with overrides, `insertProposal`, `insertCollab`, `insertMatch`, `matchFeatures`.

**Results (2026-10-05):** typecheck, lint, format, unit + integration (82 files, 951 tests), build, e2e under `next dev` and under `CI=1` (build + start): 37/37 each. On the `supabase/postgres:17.11.0.003` container: `pnpm db:migrate` applied 0009 and the hardening (43 of 43 tables with RLS), a freshly migrated database has the same constraints, indexes and columns as the dev database, and the db, contracts and notifications integration tests pass there (89 passed, 2 skipped by design). The dev database got 0009 once before its non-blank checks moved from `btrim` to the regex; those six constraints and the journal hash were brought in line by hand, and the comparison above confirms it.

### 19.25 Phase 2: supply (ideas, products, embeddings)
Built on the §19.24 contracts; no schema change was needed.

**Files**
- `lib/supply/`: `lifecycle.ts` (the one state machine for both kinds, labels, list filters; client-safe), `fields.ts` (shared field rules), `save-helpers.ts`.
- `lib/ideas/`: `fields.ts` (form schema, publish rule), `queries.ts`, `save.ts` (`createIdea`, `updateIdea`, `transitionIdea`), `brief.ts` (the drafter around its prompt), `brief-review.ts` (the acceptance rule, pure), `actions.ts`. `lib/products/` the same without the brief. `lib/money-input.ts` (typed price ↔ cents, client-safe). `lib/ai/prompts/idea-brief.ts`.
- `lib/embeddings/`: `request.ts` (+ `requestEmbeddingRefreshAfterCommit`, `requestProfileEmbeddingRefresh`), `entities.ts` (texts and stored bookkeeping per entity), `refresh.ts` (the job's work), `model.ts` (`currentEmbeddingModel`, moved from lib/social/derived.ts); job `inngest/functions/embeddings-refresh.ts`.
- Pages `/app/ideas`, `/app/ideas/new`, `/app/ideas/[id]`, `/app/products`, `/app/products/new`, `/app/products/[id]` (each with `loading.tsx`); UI in `components/supply/`, `components/ideas/`, `components/products/`. `SUPPLY_ROUTES` in lib/nav.ts lists `/app/ideas` and `/app/products`.

**Lifecycle (decided here)** (`lib/supply/lifecycle.ts`)
- Owners edit in `draft` and while published (`open` / `seeking`); `publish` only from `draft`; `archive` from `draft` or published; `restore` only from `archived` (back to `draft`). `in_collab` and `launched` are **locked**: no edit, no archive (the collab or a later phase moves them on). A non-exclusive product stays `seeking` during its collabs, so it stays editable and archivable; archiving only stops new proposals, and the collabs keep their agreed terms (the page says so).
- Every transition is a conditional update (`WHERE status IN statusesAllowing(...)`) under the row lock (`SELECT … FOR UPDATE OF ideas|products`), so a racing collab acceptance loses or wins cleanly; ownership is re-checked there too, so a wrong authorize call still cannot touch another user's row ("This idea no longer exists.").
- The form saves and publishes in one go: its "Publish" button sends `intent=publish` (create: `.created` then `.published`; edit of a draft: `.updated` then `.published`); on a published row it just saves. Archive (with a confirmation dialog) and "Restore as draft" are separate buttons. `published_at` is set on every publish (a restored draft published again gets a new time).
- **Publishing needs** (decided here): an idea a problem and ≥ 1 topic; a product a description and ≥ 1 topic (what the other side reads first, and `topic_overlap`). Drafts need only a title and a format. Refusals come back as field errors next to the fields.
- **Exclusivity:** switching a product to exclusive is refused while it has a collab that has not ended (field error), checked under the product's row lock, which an acceptance also takes.

**Fields**
- Titles ≤ 120 (inside §19.24's 200 cap), idea problem and evidence ≤ 2,000, product description ≤ 5,000 (Markdown, rendered only through `renderMarkdown`, `components/supply/markdown-text.tsx`), target user ≤ 200 (one line), demo link http(s) with `https://` added when missing (`normalizeWebUrl`), preferred builder split a whole 0–100 (`60` or `60%`), exclusivity a checkbox.
- Topics: the creator-topic rules (lowercase, `#` dropped, ≤ 8 of ≤ 40 characters; `parseTopicsInput`), so ideas, products and creator profiles share one vocabulary for `topic_overlap`. Entered with the profile forms' `TagInput`.
- **Prices are euros for now** (decided here): ideas and products store `currency = 'eur'` (launches default to `eur`, §5), so `price_fit` compares like with like. The field takes what people type ("19", "19,99", "€19", "1 299.50"; a lone `.` or `,` is the decimal mark, at most two decimals, ≤ €10,000) and the server turns it into integer cents (`parseMoneyInput`); `formatMoneyInput` writes cents back ("19", "19.05").
- `idea.created` / `product.created` carry the topics; a topic containing `@` is left out of the event (§11; it would trip the PII guard), never out of the row.

**Idea brief drafter** (§7.3.2; `lib/ideas/brief.ts`, prompt `idea_brief@v1`)
- `/app/ideas/new` has a "Draft it from your audience's comments" card above the form: pasted comments (20–8,000 characters) → `{ title, problem, audienceEvidence, format | null, targetPriceCents | null, topics }`, Zod-validated (structured output, one retry, then the empty fallback; an answer without a title and a problem counts as invalid). It prefills the form (remounted with the draft); nothing is stored until the creator saves. A failure says "We couldn't draft it right now. Fill in the fields yourself…" and the form stays usable (never blocks). Rate limit `idea-brief` 10 per creator per hour. Input: the comments inside `<untrusted_content>` (angle brackets removed) plus the creator's niche, topics and audience summary; comments are never stored, logged or put in events. `fake` builds a realistic brief from the comments (the most requested thing as the title, a format from the words used, a typical price for it, frequent words as topics, up to three quotes).
- **Events (deviation, recorded here):** the task asked for `ai.generated` with `accepted_by_user` set when the creator saves the draft largely unchanged. Events are append-only (§0, §19.5) and the decision comes after the generation, so this follows §19.6 / §19.14 instead: `ai.generated` is written **at generation** (subject `user` = the creator, since no idea exists yet; `accepted_by_user: null`; `fallback`), so every generation, abandoned ones included, is counted; the decision is `ai.reviewed { use: "idea_brief", prompt_version, accepted, edited }` with subject `idea`, written **in the idea's create transaction** when the creator saves from a draft. Acceptance rate per prompt version = `ai.reviewed.accepted` ÷ `ai.generated`.
- **"Largely unchanged"** (`reviewBrief`, `lib/ideas/brief-review.ts`): `accepted` when the saved title, problem and audience evidence keep ≥ 80% of the draft's words (Dice coefficient over lowercase word multisets); format, price and topic changes alone never make it "not accepted". `edited` when anything differs (whitespace aside).
- The form sends back a **sealed draft** (`sealBrief`: AES-GCM via lib/crypto.ts, AAD `idea_brief:<userId>`, valid 24 h), so the review compares the saved idea with what the model really wrote; a missing, tampered, expired or other user's seal saves the idea without a review.

**Embeddings** (`embeddings-refresh`, §19.24)
- Texts: ideas (title, problem, evidence, format label, topics) and products (title, description, target user, stage, format label, topics) in `lib/embeddings/entities.ts`; profiles reuse `creatorProfileEmbeddingText` and `builderProfileEmbeddingText`.
- The run skips the provider when the text's sha256, the model and a vector are all unchanged (`unchanged`); otherwise it embeds, then re-reads the row under `FOR UPDATE` and writes only if the text is still the one embedded (`superseded` otherwise: the newer edit asked for its own refresh). The write keeps `updated_at` (a derived vector is not an edit; lists sort by `updated_at`). Provider failures are reported and keep the old vector (`failed`). Empty profiles are `skipped`. Then matching is asked (`requestMatchingAfterEmbedding`) for every outcome but `not_found`: ideas/products → `requestTargetRescore` + the owner's `requestMatchingRecompute` (`idea_changed` / `product_changed`); profiles → the user's recompute (`profile_changed`) + rescore as `creator` / `builder`.
- Callers: the idea and product actions after every committed change (create, save with changes, publish, archive, restore) via `requestEmbeddingRefreshAfterCommit` (an enqueue failure is reported, never fails the save). **Phase 1 call sites switched:** profile saves and portfolio changes (lib/profiles/actions.ts), the creator summary flows (lib/social/actions.ts) and the social sync (lib/social/sync.ts: `SyncResult.embedding` is now `"requested" | "not_applicable"`, `SyncOptions.embed` is gone) all request the job; `refreshCreatorEmbedding`, `refreshBuilderEmbedding` and the unused `refreshCreatorDerived` were removed.
- Inline jobs read the app database (`getDb()`), so tests that exercise them point it at their own database (`DATABASE_URL: testDb.url`, or the `getDb` mock).

**Pages (mobile-first, §19.20)**
- Lists: status filter chips with counts (`?status=all|draft|live|in_collab|launched|archived`; "all" leaves archived out; empty filters hidden), scrolling sideways inside their own row on phones with 44 px chips; whole-card links. "New idea" / "New product" is the app bar's action on phones and a header button from `md`. Empty states for no role ("Become a creator/builder"), no profile (link to the profile step) and no items.
- Detail: owners in an editable status get the form (Save draft + Publish, or Save changes) in the sticky action bar, with a status panel (badge, what it means, Archive / Restore); locked and archived rows, and everyone else, get the read-only view (facts, topics, sanitized Markdown). Others see only published rows (`canViewIdea` / `canViewProduct`; drafts are a 404), with "Send a proposal" to `/app/proposals/new?to=…&idea|product=…` for the other role once that page is built. `?saved=created|published` shows the confirmation after a create.
- With supply built, the creator's tabs gain Ideas and the builder's Products (`appTabs`).

**Shared tests touched:** `tests/unit/nav.test.ts` and `tests/e2e/mobile.spec.ts` now derive the expected tabs, Me rows and "Soon" rows from `appTabs` / `isBuiltRoute` (they hard-coded Phase 1's bars and broke with every new page); `tests/e2e/mobile-layout.spec.ts` taps the second tab, whichever it is; `tests/integration/social/sync.test.ts` points the app database at its own (the sync's embedding request runs inline) and expects `embedding: "requested"`; `tests/integration/profiles/profiles.test.ts` uses `refreshEmbedding`.

**Tests:** unit `tests/unit/money-input.test.ts`, `tests/unit/supply/` (lifecycle, form schemas and publish rules, brief acceptance rule, embedding texts, server-rendered forms and lists), `tests/unit/ai-idea-brief.test.ts`; integration `tests/integration/supply/` (`ideas.test.ts`: writes, events, locks, ownership, actions with field errors and authorization, the embedding written after a create, the brief drafter's `ai.generated` / `ai.reviewed`, seals, fallback and rate limit; `products.test.ts`: the same plus exclusivity; `embeddings.test.ts`: outcomes, model change, provider failure, superseded runs, the job and its matching requests); e2e `tests/e2e/supply.spec.ts` (desktop: brief → publish → edit → archive → restore; a product's publish requirements → draft → publish) and `tests/e2e/mobile-supply.spec.ts` (phone: tab or Me, app bar action, 16 px fields, sticky actions above the tabs, no sideways scroll at 390 and 360 px).

**Open items**
- `in_collab → open` when a collab ends before launch, and `in_collab → launched`, belong to Phases 6 and 4.
- Currencies other than euros for ideas and products: a currency picker plus `price_fit` across currencies.
- A brief generated and never saved has `ai.generated` but no `ai.reviewed` (counts as not accepted).

### 19.26 Phase 3: proposals, threads, messages, notifications
Built on the §19.24 contracts; nothing in the schema or the frozen registries changed.

**Files**
- `lib/proposals/`: `fields.ts` (client-safe terms schema: `proposalTermsFields` + `withSplitCheck`, because Zod refuses to extend an object that has refinements; `validateSplit`, `complementPct`), `state.ts` (client-safe state machine: `PROPOSAL_TRANSITIONS`, `nextProposalStatus`, `proposalActionsFor`, `awaitingPartyId`, `partyRole`, `sendBlockReason`), `display.ts` (labels, `revisionChanges`, `formatRelative`, `formatTimeLeft`), `queries.ts`, `service.ts` (send, counter, accept, decline, withdraw), `expire.ts`, `notifications.ts`, `actions.ts`.
- `lib/threads/access.ts` (`loadThreadAccess` → the `ThreadAccess` the rules take), `lib/threads/queries.ts` (messages, participants, `markThreadRead`, `countUnreadMessages`, `listInbox`, `plainPreview`); `lib/messages/` (`fields.ts` client-safe, `attachments.ts`, `post.ts`, `download.ts`, `actions.ts`); `lib/notifications/center.ts` (list, unread count, mark read, mark all) and `describe.ts` (client-safe wording per type; a `never` check fails the typecheck when a type has no text).
- Pages `/app/proposals`, `/app/proposals/new`, `/app/proposals/[id]`, `/app/messages`, `/app/notifications` (each with a `loading.tsx` skeleton); `/app/settings/notifications` regrouped; `app/app/layout.tsx` passes the shell's counts. Route `GET /api/messages/[messageId]/attachments/[index]`. Job `inngest/functions/proposals-expire.ts`. Email templates `proposal-received.tsx`, `proposal-countered.tsx`, `proposal-accepted.tsx` (+ `_components/proposal-terms.tsx`). UI in `components/proposals/`, `components/messages/`, `components/notifications/`.
- `lib/nav.ts`: `PROPOSALS_ROUTES` lists the three menu pages, so the phone tabs now include Inbox (§19.20) and the bell shows. `tests/unit/nav.test.ts` stopped hard-coding `/app/notifications` as unbuilt and checks "no back button on any tab" over the computed tabs.

**Proposals**
- Every transition is one transaction: lock the proposal (`FOR UPDATE`), check the rule from `lib/auth/authz.ts` again under the lock, conditional update on the open statuses **and** the current revision, revision/event, notification last. Answers carry the `revisionId` the person was looking at; a different current offer is refused ("The offer changed while you were looking…"), so nobody accepts or counters terms they have not seen. Decline accepts an optional `revisionId`; withdraw needs none.
- Refusals are plain language (`PROPOSAL_MESSAGES`): your own offer ("it's their turn"), closed per status, not found for non-parties (never "forbidden": a stranger learns nothing). The actions' `authorize` throws these `ActionError`s itself, so the form shows the reason instead of the generic "You don't have permission".
- Send: the plain-language checks (`sendBlockReason`, mirroring `canSendProposal`, which stays the rule; a unit test asserts they agree on every case) and the "already open" lookup run **before** the 20/day limit, so refused sends do not count; the target is re-checked under `FOR SHARE` inside the transaction; the partial unique index settles two racing sends. `proposals.match_id` is kept only when the match is the sender's and fits (same idea/product, or the recipient for creator/builder matches), and that match becomes `proposed`; otherwise it is dropped silently.
- Past `expires_at` but not swept yet by the hourly job: answers and withdrawals are refused as expired, and the page shows it as expired (decided here; the job still writes the status, event and notifications).
- Counter on an idea/product that is no longer open is refused ("decline it or let it expire"); accept relies on `createCollabFromProposal`'s check, which rolls the whole acceptance back.
- `responded_at` is set on the recipient's first counter/accept/decline only (`to_user_id`), never by the sender's later counter.
- Expiry (`expireDueProposals`): batches of 100 walked by `(expires_at, id)`; one transaction per proposal with a conditional update; a failing proposal is reported and skipped, and the job step throws at the end so Inngest retries (only what is still due runs again). Both parties are notified with dedupe keys `proposal.expired:<id>`; every other proposal notification has one too (`proposal.<type>:<id>`, counters `:<revision_number>`).
- Party names everywhere are the display name of the person's profile **for their role in this deal** (idea owner = creator, product owner = builder; `partyRole`), else their other profile, else `users.name`, else "A creator"/"A builder". Never an email.
- Emails show split and timeline only; the scope and the sender's message stay in the app. `proposal-received` says "your/their idea" from who owns the target (either side may offer).

**Pages (mobile first)**
- `/app/proposals`: link tabs `?tab=received|sent|closed` with counts (received/sent = open ones by direction, closed = final either way), rows with "Your turn", "Answer/Expires in …". Both roles see the same page (proposals go both ways).
- `/app/proposals/new`: without `to`, an empty state pointing to Discover (when built); `to` without a target lists the sender's own open ideas (creator → builder) or seeking products (builder → creator); with a target it shows the reason when blocked, a link to the open proposal when one exists, else the form. Defaults: creator share 100 − the product's `preferred_split_builder_pct`, else 50; 4 weeks.
- The split is one range slider (creator's share) plus two linked number fields, both submitted; the server checks the sum. Scope and message are plain text (`whitespace-pre-wrap`), not Markdown.
- `/app/proposals/[id]`: non-parties get a 404 (admins read, with no actions and a read-only thread). Answer buttons render twice: a row in the terms card from `sm` up, and `FormActions` as a **direct child of the page** below `sm`, so it sticks above the tab bar while the history and messages scroll (a sticky element inside a short wrapper would not stick). Counter opens a `Sheet`, from the bottom on phones (`useIsMobile`) and from the side otherwise, with the form's action bar at `bottom-0` inside it. Accept/decline/withdraw confirm in a `Dialog`; accept repeats the terms. After acceptance the page links to `/app/collabs/<id>` (a "Coming soon" page until the collab builder's page exists).
- History: newest first, "On the table" on the current offer, changed split/timeline/scope highlighted **and** said in words ("changed, was 55% / 45%").

**Threads and messages**
- `ThreadPanel` (`components/messages/thread-panel.tsx`, async server component: `{ db, thread, viewer, closedNote }`) renders a thread: chat bubbles, Markdown through `MarkdownBody` (the only `dangerouslySetInnerHTML`, on `renderMarkdown` output), attachment links, and `MessageComposer` while `canPostMessage`. **The collab builder renders it on `/app/collabs/[id]/messages`** after `canViewThread`. Up to the newest 200 messages are shown ("N earlier messages not shown").
- Reading: `MarkThreadRead` calls `markThreadReadAction` from the browser once the messages are on screen (never during render, so a prefetch marks nothing read); `last_read_at` only moves forward, admins have no row and change nothing.
- Posting (`postMessage`): the `messages` limit, attachments promoted, then a transaction that locks the thread row (so `last_message_at` follows the newest message), re-checks `canPostMessage` (the parent may have closed meanwhile), inserts, sets `last_message_at` and the author's read mark (`greatest`), touches the collab, and tracks `message.sent { thread_kind, attachment_count }`. A message always needs text (the database requires a non-blank body), also with files. Closed proposals and ended collabs are read-only; a lapsed but unswept proposal still accepts messages until the job runs.
- Attachments: `requestAttachmentUploadAction` (20/hour, bucket `message-attachment-upload`) signs a 10-minute PUT to `message-uploads/<userId>/<uuidv7>.<ext>`; sending copies each to `message-attachments/<threadId>/<uuidv7>.<ext>` and checks the copy (type, 25 MB, the type the extension names). Any refusal deletes the copies; the action deletes the uploads after every send, accepted or refused (so the composer asks to attach again after a refused send). ≤ 5 files per message; display names are cut to 120 characters without paths or control characters. Downloads: the route checks `canViewThread`, that the key lies under the message's thread, and redirects (302, `Referrer-Policy: no-referrer`) to a 5-minute signed URL served as a download; everything else is 404, signed out included.
- `/app/messages` lists `thread_reads` rows of the user, newest activity first (≤ 100), with the other participants' names, the newest message as plain text (`plainPreview`), unread counts; proposal threads link to `/app/proposals/<id>#messages`, collab threads to `/app/collabs/<id>/messages` (§12). On phones it is the Inbox tab and links to Notifications.
- Shell counts: `app/app/layout.tsx` loads `countUnreadNotifications` and `countUnreadMessages`; every action that changes them calls `revalidatePath("/app", "layout")`.

**Notifications center**
- `/app/notifications`: in-app rows newest first, 50 per page with a keyset cursor (`?before=<iso>_<id>`), unparseable rows skipped. Each row is a form button for `openNotificationAction` (marks read, then redirects to `notificationHref`): opening works without JavaScript and a prefetch never marks anything read. "Mark all as read" and a link to the settings. The bell counts stored unread in-app rows (an unparseable one counts until "Mark all as read").
- `/app/settings/notifications`: the switches grouped by `NOTIFICATION_GROUPS`, 44 px rows on touch screens, Save in the sticky `FormActions`.
- `ProposalsHomeSection` (on `/app`, both roles): up to three proposals waiting for the user's answer, soonest to expire first; nothing when there are none.

**Tests**
- Unit: `tests/unit/proposals/state.test.ts` (every status × action, legal and illegal; who acts; `sendBlockReason` vs `canSendProposal`), `fields.test.ts` (split validation, form schema, CRLF, display helpers), `proposal-ui.test.ts` (server-rendered form, actions, history highlights, lists, composer, grouped settings); `tests/unit/messages/fields.test.ts` (attachment policy, keys, file names, body and attachment schemas, notification wording for every type).
- Integration: `tests/integration/proposals/proposals.test.ts` (send/counter/accept/decline/withdraw/expire with events, notifications and emails; refusals; duplicate and racing sends; the 20/day limit with counters exempt; racing accept vs withdraw; rollback when the idea closed; lapsed proposals; lists and counts), `actions.test.ts` (the actions with a mocked session, redirect after send, field errors), `tests/integration/messages/messages.test.ts` (posting, unread and inbox, who may post, collab activity, 30/minute limit, attachments and the download route, the post action discarding uploads, `ThreadPanel` rendered with hostile Markdown), `tests/integration/notifications/center.test.ts`.
- E2E (written, run at the gate): `tests/e2e/proposals.spec.ts` (§15 step 2 on desktop: builder sends, creator counters with a message and an attachment, builder accepts; parties-only access, duplicate refusal, withdraw) and `tests/e2e/mobile-proposals.spec.ts` (`mobile` project: sticky Send/answer bars above the tab bar, Inbox badge, notifications, bottom-sheet counter, no sideways scroll at 360/390). Both use two browser contexts (`tests/e2e/helpers/proposals.ts`, each with its own client IP) and insert the open idea in the database.

**Open items**
- No notification per message (contract): unread messages only show in the Inbox badge and on `/app/messages`; an email digest of unread messages is not built.
- Uploads attached in the composer and then abandoned (page closed before sending) stay in `message-uploads/` (same TODO as portfolio uploads: sweep objects older than an hour, Phase 6).
- Collab threads link to `/app/collabs/<id>/messages`, and accepted proposals to `/app/collabs/<id>`; both are the collab builder's pages.

### 19.27 Phase 2: matching, discover, seed, home
Built on the §19.24 contracts; no schema change was needed.

**Files**
- `lib/matching/`: `features.ts` (pure, client-safe: every §8 feature, the pair facts and `pairFeatures`), `score.ts` (pure: weighted score, contributions, score bands), `config.ts` (the active `matching_config`, Zod-checked weights), `facts.ts` (batch loaders of creator/builder facts and collab history), `candidates.ts` (§8 candidates with the pgvector prefilter; one target's audience for rescores), `recompute.ts` (`recomputeMatchesForUser`, `rescoreTarget`), `explanation-text.ts` (pure: which two features, the template sentence, the cache key), `explain.ts` (model sentences after the commit), `interactions.ts` (save, unsave, dismiss, shown, clicked), `queries.ts` (what pages read), `actions.ts`, `request.ts`. Prompt `lib/ai/prompts/match-explanation.ts` (`match_explanation@v1`).
- Jobs `inngest/functions/matching-recompute.ts`, `matching-target-changed.ts`, `matching-nightly.ts`.
- Pages `/app/discover`, `/app/discover/creators`, `/app/discover/builders`, `/app/discover/briefs`, `/app/discover/saved` (+ `loading.tsx`); UI in `components/discover/` and `components/home/` (`/app`). `DISCOVER_ROUTES` lists all five.
- Seed steps `lib/seed/people.ts`, `supply.ts`, `matches.ts` with `data.ts` (the personas) and `accounts.ts` (connections and payouts).

**Features (decided here; §8 leaves the details open)**
- Unknown inputs on either side give the neutral 0.5 (§19.24). `semantic`: pgvector's cosine (`1 - (a <=> b)`, computed in SQL so vectors never leave the database), clamped to 0–1.
- Which facts stand for each side: a creator is their profile topics plus their open ideas' topics; a builder is skills, stack and their seeking products' topics. A person-to-person pair (creator ↔ builder) compares those sets; an idea or product compares its own topics with the other person's set. `topic_overlap` is the Jaccard index over normalised topics (`normalizeTopic`).
- `format_fit`: 1 when the builder has a shipped portfolio item of the idea's/product's format (person pairs: of any of the creator's open ideas' formats), else 0.5.
- `audience_fit` = language overlap × geo overlap. Language overlap is the overlap coefficient (shared ÷ the smaller list), so a bilingual creator fully fits an English-only builder. Geo overlap is the histogram intersection Σ min(share) of the two country distributions (each renormalised to 1). Creators' countries are the latest snapshot of their largest platform, verified connections first. Builder profiles have no languages or country (§5); a builder who is also a creator lends them from their creator profile, otherwise they are unknown. An unknown factor counts √0.5, so both unknown give exactly 0.5 and one known factor still moves the feature.
- `price_fit`: §8's formula per pair (two free prices fit 1; different currencies are not comparable); across sets (a creator's ideas × a builder's products) the best comparable pair, else 0.5.
- `reliability`: 0.5, plus a quarter of the remaining gap to 1 per collab that went `live` or ended `completed` (1 → 0.625, 2 → 0.72), minus 40 % of what is left above 0 per dispute raised against the person by another member (1 → 0.3); clamped.
- `stage_fit` lookup (`STAGE_FIT_TABLE`, rows size tier, columns stage): nano idea .9 / prototype 1 / beta .7 / live .5; micro .7/.9/1/.8; mid .4/.6/1/.9; macro .2/.4/.8/1. Person pairs and ideas use the builder's best seeking product.
- Score: Σ weight × feature ÷ Σ weight (a config whose weights do not add to 1 still scores 0–1), rounded to 6 decimals. Discover's badge shows it as a percentage with a band (≥ 70 % "Great fit", ≥ 50 % "Good fit", else "Possible fit").

**Candidates and recompute**
- Candidates exactly as §19.24. pgvector prefilter: each pool is ordered by embedding distance to the subject (HNSW, `hnsw.ef_search` raised to 500 for the transaction) and capped at 500, plus up to 200 more that share a topic with the subject whatever their distance. Below the cap the result is exact.
- `recomputeMatchesForUser` rebuilds a person's list **per app role** (someone with both roles has a creator list and a builder list, each up to 30), in one transaction under a per-subject advisory lock: upsert the top 30 (never touching status), stale the rest, one `match.computed` (trigger `nightly | manual | on_change`). A person who can no longer be matched gets their whole list staled. A new row (e.g. after a model switch) starts `saved` when the person had saved that target.
- `rescoreTarget` (job `matching-target-changed`): re-scores one creator, builder, idea or product for everyone of the other role who may see it, in pages of 200 subjects (one transaction each, same advisory locks), and merges it into each list: it enters when it beats the list's 30th row, which is then staled; a target that stopped being a candidate has all its rows staled. An idea or product also rescores its owner as a person. Anything a merge cannot see (a row leaving makes room for the next candidate) is settled by the owner's recompute or the nightly run.
- `matching-nightly` (cron 05:30 UTC) fans out one `matching/recompute.requested` (reason `nightly`) per active, onboarded user with an app role: paged by id (200) with one batched send per page and event ids `matching-nightly:<user>:<day>`, like `social-daily-sync`. Inline it runs the recomputes in order and returns `{ users, failed }`.
- Pages read only rows whose target is still a candidate (`available`): a product archived or an idea taken into a collab since the last recompute disappears from Discover at once; Saved keeps it and says "No longer open".

**Explanations**
- The sentence names two features (§8): the two largest contributions. (**Superseded by §19.30**: this section first skipped features in the neutral band, a departure from §8 that was reverted; ties now prefer a non-neutral feature.)
- `templateExplanation` (deterministic, plain, addressed to "you", no names or numbers; uses shared topics, format, stage, size tier and shared languages as evidence) is both what pages show until the model's sentence is cached and the prompt's `fake` (§19.16), so they never disagree.
- The recompute keeps a cached sentence while its key (the two features plus each one's band) and the prompt version are unchanged, and clears it otherwise. Sentences are generated after the transaction (`explainMatches`, 4 at a time, conditional on the row still having no sentence and the same features), each with `ai.generated` (subject `match`, actor null, `accepted_by_user` null). A failure stores nothing; the next recompute tries again.
- The prompt sends feature names, bands and the evidence; shared topics sit inside `<untrusted_content>`. No names, titles, descriptions or emails.

**Discover and home**
- Tabs per role: creators For you · Builders · Saved; builders For you · Briefs · Creators · Saved (link tabs, 44 px, a sideways-scrolling row on phones). `/app/discover/saved` is a v1 route built now: menus keep it hidden (§19.8), Discover's tabs link to it.
- `/app/discover/creators` is builders-only and `/builders` creators-only (`canDiscover`; the other role is redirected to `/app/discover`). Briefs shows the matched open ideas first, then every other open brief newest first, 20 per page, so nothing open is out of reach of a builder.
- Card: type, score badge, title (a form button that records `match.clicked` and redirects to the idea/product page or `/c|b/<handle>`; works without JavaScript, a prefetch records nothing), facts, the sentence, topics, "Why this match" (a native `<details>` with the seven features as bars), Save/Unsave, Dismiss and "Send a proposal" (`/app/proposals/new?to=…&idea|product=…&match=…`). Buttons are 44 px on touch screens; nothing needs hover. Dismiss hides the card at once.
- `match.shown` is recorded from the browser after rendering (`MarkMatchesShown`, one batched action per list view; the server records each row once via `shown_at`). Ranks in events are the 1-based position in the list the person saw.
- Save/unsave/dismiss lock the row and are no-ops when nothing changes, so double taps record nothing twice. Saving a `proposed` match keeps it `proposed` (a `saved_items` row is still added). Unsave resets every model version's `saved` row of that target. Dismissing also unsaves.
- "Update my matches" (`refreshMyMatchesAction`): an immediate recompute of the person's lists, 5 per hour (bucket `matching-refresh`); explanations follow in the background (`runInBackground`).
- Empty states: no profile for the role (link to its profile step), not computed yet ("We're finding your matches" with the refresh button), nothing left (links to post an idea / list a product). Finishing onboarding requests the person's matches (§19.30), so "not computed yet" lasts only until that job runs.
- `/app` (role-aware, §12): setup cards (payouts; a builder's portfolio), the proposals and collabs sections, then creators get "Your audience" (tier, platforms, top countries) and "My ideas", builders "My products", and both "Top matches" (three, compact).

**Seed** (`pnpm db:seed`)
- `people`: 10 creators and 10 builders through the app's own functions (sign-up, roles, profile forms, portfolio, `upsertOAuthConnection` with a placeholder token, the sync's snapshot write, onboarding steps, the AI audience summary with fake AI, embeddings). Creators get a verified YouTube connection and snapshot (subscribers set across all four size tiers, viewer countries, ages, recent titles), builders a GitHub snapshot and 1–2 portfolio items, everyone a payouts-ready `stripe_accounts` row (`acct_seed_*`, no fake-store file: pages only re-fetch accounts that are not ready).
- `supply`: 12 ideas (open, plus a draft and an archived one) and 11 products (seeking, plus a draft), created with the form schemas and `createIdea` / `createProduct`, then embedded.
- `matches`: `recomputeMatchesForUser` for every seeded person, then `explainMatches`, so lists and sentences exist at once. People who already have match rows are skipped.
- Idempotent (people by email, ideas/products by owner and title). Steps embed synchronously with `refreshEmbedding` and never enqueue jobs. Seed connections hold a token no provider accepts and never expire: a "Resync" marks them expired, which is the honest outcome for demo data.
- Later phases extend `SEED_STEPS` in `lib/seed/index.ts`; `findUserIdByEmail`, `seedCreatorEmail` / `seedBuilderEmail` and the personas are exported for them. The collab step (§19.28) uses people 01–03; Discover's e2e specs use 05 and 06.

**Tests**
- Unit: `tests/unit/matching/features.test.ts` (every feature and edge case), `score.test.ts`, `explanation.test.ts` (bands, the neutral skip, the cache key, every template combination is one valid sentence without numbers, the prompt's untrusted block, fake = template, fallbacks).
- Integration (`tests/integration/matching/`): `recompute.test.ts` (ranking, exclusions, both roles, reliability, top 30 and staling, statuses kept, explanations cached and kept, rescore merges), `discover.test.ts` (save/unsave/dismiss persistence and events, shown once, clicked, queries hiding closed targets, Saved, other briefs, the actions with a mocked session and the refresh limit, the recompute job and the nightly fan-out in both modes), `seed.test.ts` (the three steps: counts, verified connections, payouts, statuses, every person's ranked and explained list, no email in events, idempotent).
- E2E (written, run at the gate): `tests/e2e/discover.spec.ts` (seeded creator: home top matches, ranked list with sentences, Save and Dismiss persist across a reload, Saved, Builders tab, opening a card; seeded builder: For you, Briefs, Creators) and `tests/e2e/mobile-discover.spec.ts` (Discover tab, 44 px sub-tabs and card actions, "Why this match" by tap, save/dismiss/reload, Saved, no sideways scroll at 390/360 px).

**Open items**
- Builders have no languages or country of their own, so `audience_fit` is mostly 0.5 for builder-only people. Adding them to builder profiles would need a schema change.
- With the fake embeddings (hashed bag of words) cosines are low, so the seed's rankings lean on format, stage and price; real embeddings change that.
- A match whose target changes in a way the debounced jobs have not seen yet still shows its last score until they run (10 minutes) or the nightly run.

### 19.28 Phase 3: collabs, agreements, tasks, reminders
Built on the §19.24 contracts; no schema change and no change to the frozen registries.

**Files**
- `lib/collabs/`: `create.ts` (`createCollabFromProposal`, now with the agreement), `stage.ts`, `activity.ts`, `queries.ts` (summaries, the user's list, payouts readiness per member, titles), `display.ts` (client-safe stage labels, filters, `collabNextStep`), `notifications.ts` (every collab-area notice, each with a dedupe key), `reminders.ts`.
- `lib/agreements/`: `template-v1.tsx` (text, terms builder, placeholder terms for `/legal/agreement`), `body.ts` (the text format), `generate.ts`, `integrity.ts`, `sign.ts`, `fields.ts`, `actions.ts`, `finalize.ts`, `pdf.tsx`, `queries.ts`, `download.ts`. Route `GET /api/agreements/[agreementId]/pdf`.
- `lib/tasks/` (`fields.ts` client-safe, `service.ts`, `queries.ts`, `actions.ts`).
- Jobs `inngest/functions/agreements-finalize.ts`, `reminders-stalled.ts`. Email templates `agreement-ready.tsx`, `agreement-completed.tsx` (others use `notification.tsx`). Seed step `lib/seed/collabs.ts`.
- Pages `/app/collabs`, `/app/collabs/[id]`, `/app/collabs/[id]/agreement`, `/app/collabs/[id]/tasks`, `/app/collabs/[id]/messages` (each with `loading.tsx`), `/legal/agreement`. UI in `components/collabs/`. `COLLAB_ROUTES` lists `/app/collabs`, so the Collabs tab appears (§19.20).

**Agreement text** (`body.ts`, `template-v1.tsx`)
- `rendered_body` is plain text in a small block format (`# title`, `## heading`, `- list`, `> quoted`, paragraphs, blank-line separated). The scope a party typed is always a quote block (every line `> `), so typed text cannot forge a heading or a clause. The web view (`AgreementDocument`), the hash and the PDF all use the **stored** text, parsed into the same blocks; nothing is re-rendered for display.
- Template v1 is deterministic: no `Intl`, dates in UTC as "5 October 2026", inputs normalised (NFC, control characters removed). It depends only on the terms snapshot, the collab id and the generation day, so it can be re-rendered to prove the snapshot was not changed. It says "Draft — pending legal review" inside the signed text (§18.2), so the notice is part of what is signed. A changed text is a new version (`template-v2`); stored agreements keep theirs.
- Clauses decided here (all pending the lawyer, §18.2): the product is jointly owned and neither party may sell or license it without the other's consent on the platform; each party keeps pre-existing materials with a non-exclusive licence to use them for the product; the term runs while the product is sold; exit before launch on 14 days' notice with nothing owed; after launch a leaving party keeps their share of sales for 12 months unless a buyout is agreed; serious breach not fixed in 14 days → the platform's dispute process. Governing law and courts: one sentence saying the reviewed version will set them (§18.2).
- The terms snapshot (`AgreementTerms`): parties (user id, role, display name for that role, split from `collab_members`), the accepted revision's scope and timeline, and the IP/term/exit clause texts. Parties are ordered creator then builder.

**Generation:** inside `createCollabFromProposal` (the accepting transaction): agreement row (`awaiting_signatures`, `template_version = 'v1'`, `body_hash = sha256(rendered_body)`) and `agreement.generated`. The `agreement.ready` notices to both members (dedupe `agreement.ready:<agreementId>:<userId>`; the email tells a member without payouts to set them up first) are returned and sent by `acceptProposal` after its commit (§19.30). A repeated call returns the existing agreement.

**Signing** (`signAgreement`, one transaction under the agreement's `FOR UPDATE` lock)
- Order: member check (non-members, admins included, get "not found"); already signed by this member → success again (`already_signed`, nothing written: idempotent); status/stage refusals in plain language; `canSignAgreement`; the hash of the text the signer was shown must equal `body_hash` (stale page → "reload and read it again"); the **integrity check**; then **both** members payouts-ready (`isPayoutsReady`, read now, not when the page loaded), with a message naming who still has to set up payouts.
- Integrity (`integrity.ts`, decided here): `sha256(rendered_body) = body_hash`, re-rendering the template from `terms` gives exactly `rendered_body`, and the snapshot's parties equal `collab_members` (user, role, split), so the split the ledger pays (§9) is the split signed. A failure refuses all signatures, is reported to Sentry, and tells the user we will contact them.
- Recorded: typed name (NFC, whitespace collapsed, 2–120 characters; the field must not be blank), `signed_at`, the IP only when it parses as an address (from `clientIp`), the user agent without control characters (≤ 500), and the `body_hash` signed. `agreement.signed { role }`, `touchCollabActivity`, and `agreement.signed` to the member who has not signed yet (dedupe per agreement and recipient).
- The last signature, in the same transaction: conditional update to `signed` + `completed_at`, `agreement.completed`, `changeCollabStage(agreement → building)`. After the commit it enqueues `agreements/finalize` (event id `finalize:<agreementId>`); an enqueue failure is reported, never thrown (the signatures stand).
- Two members signing at the same moment serialize on the lock; exactly one completes (tested).

**Finalize** (`agreements-finalize`, two steps, each idempotent)
- `store-pdf`: renders the PDF with `@react-pdf/renderer` (imported lazily: an ES module that `tsx` scripts cannot `require()`), stores `agreements/<collabId>/<agreementId>.pdf`, and sets `pdf_storage_key` only if still null (a concurrent run's key wins). The PDF prints the stored text, then one signature record per party (typed name, role, time, fingerprint signed; **no IP or browser since §19.30**), and the agreement id, fingerprint and page number on every page. Font: Geist from TTF files committed under `lib/agreements/fonts/` (§19.30; a missing font fails the step, never a Helvetica fallback).
- `email-members`: `agreement.completed` to both with the PDF attached (`collaboration-agreement-<title slug>.pdf`), dedupe `agreement.completed:<agreementId>:<userId>`. A required email (§19.30): it ignores the email preference and a failed send fails the step, which Inngest retries.
- Safety net: the daily `reminders-stalled` run re-enqueues finalize for signed agreements still without a PDF, or with a member who never got the PDF email, 10 minutes to 7 days after completion, with a per-day event id (§19.30).
- Download: `GET /api/agreements/<id>/pdf` redirects members and admins (`canViewCollab`) to a 5-minute signed URL (`Referrer-Policy: no-referrer`); everything else, signed out included, is 404. The agreement page polls (`SyncRefresher`) for up to 10 minutes after completion until the PDF exists.

**Tasks** (`lib/tasks/service.ts`)
- Members of a collab that has not ended (`canWorkInCollab`) create, edit, complete, reopen, reorder (move up/down) and delete tasks; admins read. Every change locks the collab row (`FOR NO KEY UPDATE`), re-checks the rule, and touches the collab's activity.
- Fields: title ≤ 200 (non-blank), notes ≤ 2,000, assignee = a member or nobody (others refused), due date a real calendar day (`YYYY-MM-DD`).
- Positions: new and reopened tasks go to the end; a move renumbers the open tasks 0…n−1 in their shown order. Done tasks are listed separately, newest first.
- Events: `task.created { collab_id, assigned }`, `task.completed { collab_id, on_time }` (null without a due date), `task.reopened`. **Edits, moves and deletions emit no event** (the catalog has none and is frozen; deviation recorded here). Deleting is a hard delete (§5 marks no soft delete for tasks). `task.assigned` notifies a new assignee other than the actor (dedupe per task, assignee and time).

**Reminders** (`reminders-stalled`, daily 08:50 UTC): `collab.stalled` to both members of collabs in `agreement` or `building` idle 7+ days (dedupe `collab.stalled:<collabId>:<last_activity_at ms>`, so once per quiet spell); `agreement.reminder` to each unsigned member of an agreement awaiting signatures generated 3+ days ago (dedupe per agreement and member: once, ever); only active users. Keyset pages of 100; a failing notice is reported and skipped, and the step then throws so Inngest retries (dedupe keys keep retries silent). The run's time is fixed in its first step.

**Pages (mobile first)**
- `/app/collabs`: the user's own collabs, stage filter chips (`?stage=`, "Active" by default) scrolling inside their row, each row with partner, the user's split and the next step; a collab waiting for the viewer's signature links straight to its agreement ("Your turn").
- Collab pages share `CollabHeader` (title, partner, stage badge) and `CollabNav` (Overview, Agreement, Tasks, Messages as links with their own URLs; a sideways-scrolling row with 44 px targets on phones). The overview shows the stage track, members and splits, the next step, scope and timeline.
- Agreement: the text, fingerprint, signature list with payouts state per member, and the sign form. The form wraps the text, so on phones the Sign bar (`FormActions`) stays above the tab bar while the text scrolls; signing with an empty name focuses the field. When payouts are missing the button is disabled and an alert explains it, with "Set up payouts" (→ `/app/settings/payouts`) for the viewer.
- Tasks: "New task" is the app bar's action on phones (a bottom sheet with 16 px fields) and a header button from `md`; done toggles, move and delete controls are 44 px on touch screens.
- Messages: the proposals builder's `ThreadPanel` on the collab thread (§19.26), after `canViewCollab` and `canViewThread`; read-only once the collab has ended.
- Every page: `requireOnboardedUser()`, a UUID check, `canViewCollab`; anything else is `notFound()` (strangers learn nothing).
- `CollabsHomeSection` on `/app`: up to three active collabs, those waiting for the viewer's signature first.
- `/legal/agreement`: template v1 rendered by the same code with placeholder terms in [brackets], plus the draft notice.

**Seed** (`lib/seed/collabs.ts`): three collabs between seeded pairs 01–03, made through `sendProposal` + `acceptProposal` (so the agreement and events are real), in three different stages (§15; changed in §19.30): 01 `agreement` signed by the creator only, 02 `ended` (cancelled before signing, agreement `terminated`), 03 signed by both (PDF stored and emailed, `building`, three tasks with one done, two messages). Skips pairs whose people or open idea are missing and pairs that already share a collab.

**Tests:** unit `tests/unit/agreements/template.test.ts` (determinism, block round trip, quoted scope cannot forge a heading, draft notice), `tests/unit/collabs/collab-ui.test.ts`, `tests/unit/tasks/fields.test.ts`; integration `tests/integration/collabs/` (`agreements.test.ts`: generation on acceptance, payouts-ready refusals with names, typed name and stale hash, tampered terms and split mismatch, non-members, idempotent double sign, IP cleaning, completion → `building` + events + PDF stored + emailed once with the attachment, simultaneous signatures, ended collab, the download route; `tasks.test.ts`; `reminders.test.ts`; `seed.test.ts`; `pages.test.ts`: the four collab pages for members, admins, strangers and bad ids); e2e `tests/e2e/collabs.spec.ts` (§16 Phase 3 acceptance: proposal → accept → payouts through fake Connect → both sign → PDF stored, emailed with the attachment, collab in `building`; tasks and messages; 404s for a stranger) and `tests/e2e/mobile-collabs.spec.ts` (`mobile` project).

**Open items**
- Governing law and the lawyer's review of v1 (§18.2) before real money flows.
- Ending a collab (exit, dispute, admin) and terminating/replacing an agreement are Phases 6 (and 4 for the launch stages); `changeCollabStage` and `agreements.terminated_at` are ready for them.
- `stripe_events`-style GDPR redaction does not touch agreements: signatures keep IP and user agent as evidence (legally required records; only in `agreement_signatures`, never in the emailed PDF since §19.30); decide their retention with the Phase 6 GDPR work.

### 19.29 W2 integration gate (Phases 2–3): findings and fixes
The gate for §19.25–§19.28. GitHub CI on the pushed head (`3e89515`, before this wave's work) was green.

**Real 404s for private pages** (`app/app/{collabs,proposals,ideas,products}/`)
- `notFound()` called inside a `loading.tsx` Suspense boundary renders the not-found UI but answers **200** (the shell has already streamed). Every `[id]` page sat inside its own `loading.tsx` *and* the list's (`collabs/loading.tsx` wraps `collabs/[id]` too), so a stranger opening someone's collab, proposal or draft got the "Page not found" content with status 200. Nothing leaked, but §19.19's rule (404s keep the shell, status 404) and the e2e checks failed.
- Fix: each list page and its skeleton moved into a `(list)` route group (`collabs/(list)/page.tsx` + `loading.tsx`, same URL), so the list skeleton no longer wraps `[id]`; and each `[id]` segment has a `layout.tsx` that runs the access check (`requireOnboardedUser`, UUID, the loader, `canViewCollab` / `canViewProposal` / `canViewIdea` / `canViewProduct`) outside every Suspense boundary. The pages keep their own checks (§19.9). **Rule for new dynamic pages with a `loading.tsx`:** do the access check in the segment's `layout.tsx`, and keep a list page's `loading.tsx` out of its siblings' way with a route group.
- `tests/integration/collabs/pages.test.ts` also covers the collab layout.

**Select values survive a refused submit** (`NativeSelect`, components/profiles/form-kit.tsx)
- React resets a form after its action. Inputs pick up the new `defaultValue` that `useFormAction` passes back, but a `<select>` applies `defaultValue` only on mount, so after a refused Publish the product form's Format fell back to "Choose a format" and the next Save failed with "Pick a format." (also silently cleared the creator profile's country, the idea format and the task assignee). `NativeSelect` now remounts its uncontrolled `<select>` when its `defaultValue` changes.

**No sideways scroll from long titles** (`app/app/page.tsx`, Discover, the collab overview)
- A `grid` without explicit columns gets one implicit `auto` track on phones, which grows to its widest item's min-content; a `truncate`d (nowrap) idea title therefore made the creator home 529 px wide on a 390 px phone (the browser zoomed the layout out). Those grids now start with `grid-cols-1` (`minmax(0, 1fr)`). **Rule:** a grid that can hold user text uses `grid-cols-1` at the base breakpoint.

**`next dev` memory during e2e** (`playwright.config.ts`)
- With the Phase 2–3 routes the dev server again grew to 12+ GB within the sandbox's 13.4 GB cgroup and was OOM-killed mid-suite (§19.22). `turbopackMemoryEviction: "full"` only evicts after Turbopack snapshots its cache, which waits for a quiet period a running suite never leaves. Playwright's web server now sets `TURBO_ENGINE_SNAPSHOT_MIN_ACTIVE_TIME_MILLIS=3000` and `TURBO_ENGINE_SNAPSHOT_IDLE_TIMEOUT_MILLIS=500` (undocumented Turbopack variables, read by the 16.3 binary; ignored by `next start`). Measured on all 32 app routes in a row with a warm cache: peak 5.7 GB → 3.6 GB. Spikes while a large module graph compiles for the first time still reach ~10–12 GB briefly; no OOM kill in the gate runs after the change. `pnpm dev` itself is unchanged.

**Test fixes (no app change)**
- `chooseRole` (tests/e2e/helpers/auth.ts) waits until the role page has redirected. It returned right after the click, so `completeOnboardingInDb` could read the user before the roles were committed ("choose a role first"), failing every spec that uses `newPerson` (collabs, proposals, supply, their mobile versions).
- Specs written against Phase 1's tab bar derive the expected state from `lib/nav.ts` now (`mobile-desktop.spec.ts`: a built item is a link, a planned one a "Soon" row; `mobile.spec.ts`: the "Coming soon" page is the first unbuilt builder menu item; `mobile-pages.spec.ts`: both roles share the final five tabs, so the role switch is checked on the home page).
- Bottom sheets are measured once their slide-in has finished (`expect.poll`), and the sticky-bar helpers scroll the button's form into view first: a sticky bar cannot rise above its form's top, so on `/app/ideas/new` (the AI brief card comes first) and the agreement page (signatures first) it sticks once the form is reached, which is the intended behaviour. On `/app/collabs` itself the Collabs tab is `aria-current="page"` (the spec expected `"true"`).

**Acceptance and audit**
- Seed: from an empty database `pnpm db:reset && pnpm db:seed` creates 20 people, 23 ideas/products, 390 matches (all explained) and 3 collabs in ~9 s; a second run creates nothing.
- Phase 2 and Phase 3 walk, scripted with Playwright on a 390 × 844 touch viewport in dark mode against `pnpm dev` (`FAKE_SERVICES=all`) on the freshly seeded database: seeded builder 08 sees 20 ranked matches, all explained ("This brief fits what you build partly, and your products are at a stage that suits a micro audience."); Save and Dismiss persist across a reload (`saved` 1, `dismissed` 1, the dismissed card gone) with `match.shown` / `match.saved` / `match.dismissed` events; the builder proposes on creator 08's idea, the creator counters in the bottom sheet, the builder accepts, both sign (seeded payouts are ready): collab `building`, agreement `signed` with 2 signatures, the PDF in fake storage, and the "is signed" email with the PDF attached to both; proposal events `proposal.sent`, `proposal.countered`, `proposal.accepted`; no email or token in any event property; a third seeded user gets 404 on the collab's four pages and on the proposal. Every new page (home, Discover, briefs, saved, proposal new/received/countered, collab overview/agreement/tasks/messages, collabs, proposals, messages, notifications, ideas, products, Me) at 390 px: no sideways scroll, layout width 390, fields ≥ 16 px, dark theme, no console errors; the agreement page also checked in light mode.
- Cross-cutting checks: every collab page and action authorizes with `canViewCollab` / `canWorkInCollab` / `canSignAgreement` (members and admins only; admins read); every §11 Phase 2–3 event type is emitted somewhere; proposals use `RATE_LIMITS.proposals` (20/day, new proposals only) and messages `RATE_LIMITS.messages`; user Markdown reaches `dangerouslySetInnerHTML` only through `renderMarkdown` (`MarkdownBody`, `MarkdownText`).
- README: what works in Phases 1–3, the seeded demo accounts, the final tab bar.

**Gate results (2026-10-06):** typecheck, lint, format, unit + integration (114 files, 1260 tests), build, e2e under `next dev` (51/51, dev server peak 4.4 GB) and under `CI=1` (build + start, 51/51); desktop project 26, `mobile` project 25. The walk above passed with no console errors. Scratch databases left for inspection: `creator_gate_seed` (local Postgres; the walk's seeded data).

### 19.30 W2 (Phases 2–3): review findings
Fixes for the W2 review. Each has a test that fails without it.

**Notifications that must arrive** (`lib/notifications/notify.ts`)
- `notify({ email: { …, required: true } })`: a transactional or legal email. It ignores the user's email preference, and a failed send throws instead of being reported and swallowed. The dedupe claim and the in-app row are written in a savepoint that the failure rolls back, so a retry claims the key and sends again (Resend's idempotency key, `notification:<user>:<dedupeKey>`, keeps a send that did go through from going out twice). The in-app row still follows the in-app preference.
- **Decided here:** the signed-agreement email (`agreement.completed`, PDF attached) is required: it is the legal record §12 says to email, like a receipt. Settings → Notifications shows its email switch checked and disabled with "Always emailed: it carries your signed agreement." (`REQUIRED_EMAIL_TYPES` in lib/notifications/types.ts); the in-app switch still works. Every other type keeps its switches.
- So `agreements-finalize`'s `email-members` step fails when Resend fails and Inngest retries it; the PDF is not rendered again (key already set).

**Finalize safety net** (`lib/collabs/reminders.ts`, `requestAgreementFinalize`)
- The post-signature enqueue keeps the event id `finalize:<agreementId>`; the daily re-send uses `finalize:<agreementId>:retry:<UTC day>`, so Inngest (which drops a repeated event id for 24 hours) never discards it as a duplicate of the run that failed.
- It now also picks up signed agreements whose PDF exists but a member has no `agreement.completed:<agreementId>:<userId>` row (a required email's row only exists once it was sent), from 10 minutes to **7 days** after completion; after that it gives up (an address that never accepts mail would otherwise retry forever; the failures are in Sentry).

**Signed-agreement PDF** (`lib/agreements/pdf.tsx`)
- Fonts: `Geist-Regular.ttf` and `Geist-SemiBold.ttf` are committed under `lib/agreements/fonts/` (with the SIL OFL licence, `OFL.txt`) and listed in `outputFileTracingIncludes` (next.config.ts) for `/api/inngest`, `/app/collabs/[id]/agreement` (the sign action finalizes inline when jobs are fake) and `/api/test/jobs/[name]`. The file tracer cannot follow the runtime path into `node_modules/geist`, so a traced deployment would have rendered every PDF in Helvetica (WinAnsi: "Łukasz Żółć" and Cyrillic names mangled in the legal record). A missing font now throws `AgreementFontMissingError` (the step fails, is reported and retried); there is no fallback. **Add any new route or job that renders the PDF to that list.**
- The PDF no longer prints a signer's IP address or browser: both parties receive it, and a counterparty's IP is personal data (§14). The values stay in `agreement_signatures` for admins and disputes; the PDF says the platform keeps the technical record.

**`agreement.ready` after the commit** (`lib/agreements/generate.ts`, `lib/proposals/service.ts`)
- `generateAgreement` / `createCollabFromProposal` return `readyNotices` instead of notifying (empty when the collab already existed); `acceptProposal` sends them with `sendAgreementReadyNotices` after its transaction commits (failures reported, never thrown). Before, both members could get "Your agreement is ready to sign" for an acceptance that then rolled back. This changes the §19.24 contract: **a caller of `createCollabFromProposal` sends `readyNotices` after its own commit.**

**Matching when a person becomes matchable** (`lib/onboarding/complete-step.ts`, `lib/matching/request.ts`)
- `requestMatchingForPerson(userId, roles)`: the person's own recompute (reason `profile_changed`) plus a rescore as `creator` / `builder` target per role; enqueue failures reported, never thrown.
- Finishing onboarding calls it after the commit that set `onboarding_completed_at`. `OnboardingAdvance` gained `completedRoles`. `completeOnboardingStep` and `advanceOnboarding` request it themselves **when they own the transaction**; a caller that passes its own transaction calls `requestMatchingAfterOnboarding(userId, advance)` after committing (done in `chooseRoles`, `confirmAudienceReview`, the profile saves, and the Stripe `account.updated` path via `runInBackground`, which runs after the webhook response, so after its transaction). Before, every embedding-driven request happened during onboarding, when matching (onboarded people only) stored nothing, so new users had no matches and were invisible until the nightly run.
- A builder's `availability` change (candidacy, §8 "availability ≠ closed") requests the same directly (`BUILDER_CANDIDACY` in lib/profiles/actions.ts), since it does not re-embed. `deal_preference` is not a matching input and requests nothing.
- The seed records its onboarding steps inside a transaction (`recordStep`), so it still never enqueues jobs (§19.27); its matches step computes everyone's lists once supply exists.

**Match explanations follow §8** (`lib/matching/explanation-text.ts`)
- `explainedFeatures` ranks by contribution (weight × value) only; an exact tie prefers a feature outside the neutral band, then §8's order. §19.27's "skip neutral features" is reverted: it named weak features (which lowered the score, e.g. `topic_overlap` 0) ahead of larger neutral contributions, contradicting §8's "top two contributing features", and it was decided without the sign-off §0 requires. **Open question for Trifon:** whether neutral (mostly unknown-input) features may be skipped in the sentence; until then the copy for neutral bands ("reasonably", "nothing … stands in the way") is what people see when an unknown input ranks second. Cached explanations whose key changes are regenerated by the next recompute.

**Seed: three stages** (`lib/seed/collabs.ts`): see §19.28 "Seed". `ended` uses `changeCollabStage` (reason `cancelled`, actor the creator) and marks the unsigned agreement `terminated` in the same transaction (no event: the catalog has none, `collab.ended` records it). `launch_review` and `live` arrive with Phase 4's launches seed. README updated.

**`/app/proposals/new` hides private targets**: after `loadSendContext`, the page answers 404 unless `canViewProposalTarget` (new in lib/auth/authz.ts: `canViewIdea` / `canViewProduct`) passes, so a draft or archived title is never shown to someone holding its id.

**Marking a thread read** (`markThreadRead`, `markThreadReadAction`): the action takes the newest message the page rendered (`messageId`) and moves `last_read_at` to that message's `created_at` (same thread only; never backwards), not to the thread's newest at the time the action runs, so a message posted between render and hydration stays unread.

**Proposal lists page** (`listProposals`): keyset pagination on (`closed_at` for Closed, else `updated_at`, id), 50 per page, `?tab=…&before=<iso>_<id>`, "Older proposals" / "Back to the newest" like `/app/notifications`. `listProposals` now returns `{ items, hasMore }`; `proposalCursorAfter(item, tab)` builds the cursor.

**E2E flake:** `mobile-proposals.spec.ts` failed once under `CI=1` (passed on retry) because `getByLabel("What you'll build together")` matched a second, hidden copy of the proposal form; it now locates the field by role, which skips hidden elements (4/4 on repeat).

**Tests:** `tests/integration/notifications/notify.test.ts` (required email: preference ignored, failure releases the key, retry sends once), `tests/integration/collabs/agreements.test.ts` (finalize email failure then retry; no `agreement.ready` after a rolled-back acceptance), `tests/integration/collabs/reminders.test.ts` (missing PDF email re-sent with per-day ids, gives up after 7 days), `tests/unit/agreements/pdf.test.ts` (new: Geist embedded for Polish and Cyrillic names, no Helvetica; missing fonts throw; fonts traced), `tests/integration/onboarding/onboarding.test.ts` (matching requested once on completion; left to a caller's transaction), `tests/integration/profiles/profiles.test.ts` (availability change), `tests/unit/matching/explanation.test.ts` (contribution ranking, ties), `tests/integration/collabs/seed.test.ts` (three distinct stages), `tests/unit/auth/authz.test.ts` (`canViewProposalTarget`), `tests/integration/messages/messages.test.ts` (read up to the rendered message), `tests/integration/proposals/proposals.test.ts` (cursor paging), `tests/integration/contracts/w2-contracts.test.ts` (`readyNotices`).


### 19.31 W3 contracts: Phases 4–5 groundwork (launches, checkout, ledger, payouts)
Written before the four Phase 4–5 builders start, two at a time: **launch** ∥ **ledger**, then **checkout** ∥ **payouts**. Builders do not change the schema; this section is the interface between them. A builder who needs a change in a frozen file stops and reports it.

**Areas and owners**
- **launch** (P4): `lib/launches/**` (incl. `status.ts`, written here), `lib/attribution/**` (`cookie.ts` written here), `lib/ai/prompts/launch-kit.ts`, `app/app/collabs/[id]/launch/**`, `app/app/launches/**` (list and `[id]/kit`), `app/p/[slug]/page.tsx` (+ layout, not checkout/success), `app/r/[code]/route.ts`, `app/admin/launches/**`, `components/launches/**`, `lib/stripe/{live,fake}-promotions.ts`, seed step `lib/seed/launches.ts`, nav list `LAUNCH_ROUTES`.
- **ledger** (P5 core): `lib/ledger/**` (`types.ts` and signature stubs written here), `scripts/ledger-check.ts` + the `ledger:check` package script, `lib/stripe/{live,fake}-money.ts`, job `inngest/functions/ledger-post-pending.ts`.
- **checkout** (P4, after launch): `app/p/[slug]/checkout/**`, `app/p/[slug]/success/**`, `app/access/[token]/**` (not `/refund`), `lib/checkout/**`, `lib/orders/**`, `lib/delivery/**` (`token.ts` written here), `lib/stripe/handlers/checkout.ts`, `lib/stripe/{live,fake}-checkout.ts`, the fake checkout page under `app/api/dev/fake-stripe/checkout/**`, `lib/email/templates/{buyer-receipt,sale-made}.tsx`, job `orders-fulfilled`, seed step `lib/seed/orders.ts`.
- **payouts** (P5, after ledger): `lib/payouts/**` (except `readiness.ts`), `lib/refunds/**`, `lib/chargebacks/**`, `lib/stripe/handlers/{refunds,disputes,transfers}.ts`, `app/app/earnings/**`, `lib/email/templates/{payout-sent,refund-confirmation,dispute-opened}.tsx`, jobs `payouts-release`, `payouts-reverse`, `refunds-notify`, `ledger-check`, nav list `EARNINGS_ROUTES`.
- Frozen for builders (as in §19.24, plus): `lib/db/schema/**`, `drizzle/**`, `lib/events/types.ts`, `lib/notifications/types.ts` + `describe.ts`, `inngest/client.ts`, `inngest/functions/index.ts`, `lib/auth/authz.ts`, `lib/stripe/gateway.ts`, `lib/stripe/{ids,checkout-shared,money-shared,promotions-shared,shared}.ts`, `lib/stripe/handlers/{index,define}.ts`, `lib/stripe/webhooks.ts`, `tests/helpers/db-fixtures.ts`. Each builder replaces only its own stubs (`StripeGatewayNotBuiltError` methods, `notBuiltYet` job handlers, `lib/ledger/*` throwing stubs, empty handler groups, seed steps); delete `inngest/functions/not-built.ts` once nothing imports it. `CLAUDE.md`: launch §19.32, ledger §19.33, checkout §19.34, payouts §19.35.
- Tests: area fixtures in `tests/integration/<area>/helpers.ts`, e2e `tests/e2e/<area>*.spec.ts`, phone checks `tests/e2e/mobile-<area>.spec.ts`. Shared fixtures added here: `insertTrackedLink`, `insertPayoutBatch`, `insertTransfer`, `insertLedgerEntry`, `insertOrder(…, overrides)`; `insertLiveLaunch` sets `submitted_at` / `went_live_at`.

**Schema (migration `0010_w3_launch_money`, generated; tests in `tests/integration/db/w3-constraints.test.ts`)**
- Every changed table was empty in every environment (no launch, order, transfer or refund exists yet), so the `NOT NULL` columns without defaults (`transfers.batch_id`, `destination_account_id`) needed no backfill. Applied on the `supabase-db` container; the hardening covers the three new tables (46 of 46 with RLS).
- New enums: `launch_paused_by` (`member | admin | dispute`; replaces the event-only type), `order_attribution` (`cookie | ref | discount_code`), `refund_status` (Stripe's five values), `chargeback_status` (`open | won | lost`), `payout_batch_status` (`running | completed | failed`), `transfer_reversal_status` (`pending | succeeded | failed`).
- `launches`: `tax_code` (`txcd_` + 8 digits; null = `DEFAULT_TAX_CODES[delivery_type]`), `submitted_at` (required in `pending_approval` / `admin_review`), `reviewed_by_user_id` + `reviewed_at` (together), `review_note`, `paused_at` + `paused_by` (set exactly while `paused`), `ended_at` (exactly when `ended`); `went_live_at` required while `live` / `paused` (first go-live; never cleared). Price 50–1,000,000 cents (Stripe's EUR minimum; the platform's ceiling) when set; slug 3–80 characters; non-blank title; lowercase currency; `delivery_config.type` = `delivery_type`; `approved_by` and `media` are JSON arrays.
- `launch_files.position` (display order), 200 MB size cap (§14), non-blank file name.
- `tracked_links`: `is_default` (at most one per launch), `discount_code` now unique **platform-wide** (Stripe promotion codes are unique per account; was per launch), uppercase `[A-Z0-9]{4,20}`, `discount_percent_off` 1–100 set exactly with the code, `stripe_promotion_code_id` (unique, needs a code), `disabled_at`, label ≤ 80.
- `orders`: `id` **is the `order_ref`** (decided here: a UUIDv7 made before the session, sent as `metadata.order_ref` / `client_reference_id`, used as the row id at completion; no separate column). Added `stripe_charge_id`, `stripe_balance_transaction_id` (both unique), `discount_cents`, `amount_refunded_cents` (0…gross), `buyer_country`, `attribution` (set exactly with `tracked_link_id`), `ledger_posted_at` (needs the balance transaction id); status ⇔ refunded amount (`paid` 0, `partially_refunded` between, `refunded` = gross; `disputed` any); tax ≤ gross; partial index of unposted orders.
- `license_keys.assigned_at` (exactly with `order_id`), key non-blank ≤ 200. `access_grants`: token `^[A-Za-z0-9_-]{43}$`, at most one unrevoked grant per order.
- `refunds`: `status` (default `pending`), `currency`, `failure_reason`, `requested_by_user_id`, `ledger_posted_at`.
- New `chargebacks` (Stripe disputes; §5's `disputes` stays the collab-dispute table): order, `stripe_dispute_id` (unique), amount, `fee_cents`, currency, reason, `status` + `stripe_status`, `opened_at`, `closed_at` (exactly when not open), `ledger_posted_at` (only when lost).
- New `payout_batches`: `run_key` (unique; `daily:<YYYY-MM-DD>` or `manual:<uuid>`), `cutoff_at`, status, `started_at`, `completed_at` (exactly when not running), counts.
- `transfers`: `batch_id` (required), `destination_account_id`, `failure_code` (only when failed); one transfer per (batch, user, currency); a Stripe id unless pending or failed.
- New `transfer_reversals`: transfer, `refund_id` or `chargeback_id` (at most one), `stripe_reversal_id` (unique; required when succeeded), amount, status, `failure_code`.
- `ledger_entries.chargeback_id`; at most one of refund/chargeback, either one needs an `order_id`; platform entries (user null) never get a `transfer_id`; partial index of unpaid user entries. The append-only trigger is unchanged (only `transfer_id` NULL → value).

**Stripe gateway** (`lib/stripe/gateway.ts`)
- `StripeGateway = ConnectGateway & CheckoutGateway & MoneyGateway & PromotionsGateway`, each with a live and a fake file: Connect (Phase 1, `live.ts` / `fake.ts`, unchanged behaviour), checkout (`createCheckoutSession`, `retrieveCheckoutSession`, `retrievePaymentIntentWithBalanceTransaction`, `retrieveCharge`), money (`retrieveBalanceTransaction`, `createTransfer`, `listTransfersByGroup`, `createTransferReversal`, `createRefund`, `retrieveRefund`, `retrieveDispute`), promotions (`createPromotionCode`, `deactivatePromotionCode`). Stubs throw `StripeGatewayNotBuiltError` naming the owner. `StripeGatewayError` codes gained `balance_insufficient` and `charge_already_refunded`.
- Object schemas (Stripe field names, only what we read, `stripeIdSchema(prefix)` / `expandableIdSchema` / `stripeIdOf` from `lib/stripe/ids.ts`): `checkout-shared.ts` (session, PaymentIntent with expandable `latest_charge`, charge with `balance_transaction` id | object | null), `money-shared.ts` (balance transaction, transfer, reversal, refund, dispute, plus input types), `promotions-shared.ts`. `schemas.ts` re-exports them.
- The fake store gained object types `checkout_session`, `payment_intent`, `charge`, `balance_transaction`, `transfer`, `transfer_reversal`, `refund`, `dispute`, `coupon`, `promotion_code` (`unixSeconds`, `randomId` exported for the topic files). Fake constants for the checkout builder: `FAKE_STRIPE_FEE` (1.5 % + €0.25, half up) and `FAKE_TAX_RATE_BPS` (21 % included). Fake ids use Stripe's prefixes (`cs_fake_…`, `pi_fake_…`, `txn_fake_…`).
- **Webhook dispatch:** topic groups `checkout`, `refunds`, `disputes`, `transfers` are registered (empty) in `handlers/index.ts`; owners fill their file only. The handler context gained **`afterCommit(task)`**: tasks run in order after the event's transaction commits, never after a rollback; a failing task is reported and does not fail the (processed) event, so anything that must happen is **enqueued as a job** from `afterCommit` (tested in `tests/integration/stripe/after-commit.test.ts`).
- Events to enable on the endpoints (§19.10): account endpoint `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.updated`, `refund.created`, `refund.updated`, `refund.failed`, `charge.refunded`, `charge.dispute.*`, `transfer.reversed`; Connect endpoint as Phase 1.

**Launch status machine** (`lib/launches/status.ts`, pure; `launchStatusAfter(status, action, { allMembersApproved, autoApprove })`)
- A collab in `building` (agreement signed) gets one launch (`launch.created`), slug from the title (unique, editable until `went_live_at` is set; fixed after, so links never break).
- `save` (a member; statuses `draft | pending_approval | admin_review | paused`, `canEditLaunch`): approvals reset to `[]`, `submitted_at` cleared; `pending_approval` / `admin_review` → `draft`, `paused` stays `paused`. `launch.updated { fields, approvals_reset }`. A `live` launch is paused before it is edited (decided here; resolves the old TODO in authz).
- `approve` (each member once per version, `canApproveLaunch`; the launch must be complete: title, price, delivery type and its content: ≥ 1 file, ≥ 1 unassigned key, or an https URL): appends `{ userId, role, approvedAt }`, `launch.approved { role }`. First approval: `draft → pending_approval`, `submitted_at`, `launch.submitted`, `launch.approval_requested` to the other member. Both: → `admin_review` (`admin.launch_review_requested` to every admin) or, with `AUTO_APPROVE_LAUNCHES=true`, → `live`. In `paused`, approvals only re-arm `resume`.
- `admin_approve` / `admin_reject` (`canReviewLaunch`): → `live` (`launch.approved { role: "admin" }`, `reviewed_*`) or → `draft` with `review_note`, approvals reset, `launch.rejected` + notice to both.
- **Going live** (both paths, one transaction): `went_live_at` (first time only), `launch.live { auto_approved }`, the creator's **default tracked link** (`is_default`, label "Default", owner = the creator member; `tracked_link.created`), the idea `in_collab → launched` and an exclusive product `in_collab → launched` (a non-exclusive product stays `seeking`), collab stage via `collabStageForLaunch`; after the commit `revalidatePath("/p/<slug>")` and `launch.live` to both members.
- `pause` (member or admin, `canPauseLaunch`; `paused_at`, `paused_by`, `launch.paused { by }`, notice to the other member or both); `resume` (`canResumeLaunch`: a member-paused launch by a member with both approvals of the current version; admin/dispute-paused by an admin only; `launch.resumed`); `end` (admin, or the collab ending: `ended_at`, `launch.ended { by }`). `paused_by = dispute` is for Phase 6 collab disputes; chargebacks do not pause launches. Every public change revalidates `/p/<slug>`.
- Collab stage (`collabStageForLaunch`): `building → launch_review` when the launch leaves draft, back to `building` when it returns to draft, `launch_review → live` on first go-live. Checkout sells only `live` launches (`isSellable`); `/p/[slug]` is public for `live | paused | ended` (`PUBLIC_LAUNCH_STATUSES`; paused/ended show "not available", 200), otherwise 404.
- `/p/[slug]` is static (on-demand revalidation). **`product_page.viewed`** comes from a `navigator.sendBeacon` POST to `app/p/[slug]/view/route.ts` (launch owner; deviation from §4's route-handler list: anonymous visitors cannot call `defineAction`, which needs a user), rate limited per IP with the `redirect` bucket, actor null, `tracked_link_id` from the cookie, no IP stored.

**Attribution** (`lib/attribution/cookie.ts`)
- `/r/[code]` (route handler, `RATE_LIMITS.redirect` per IP): unknown or disabled code → 404 page; else insert `link_clicks` (`clicked_at`, referrer origin only, country from the platform header if present, `ua_hash` = HMAC of the UA, `visitor_id` from `vid`, `is_bot` from a UA list) and `link.clicked { is_bot }`, set `attr=<tracked_link_id>` (UUID only, httpOnly, Lax, Secure on https, path `/`, 30 days: **last click wins**) and `vid` (16 random bytes base64url, issued once), then 302 to `/p/<slug>`. Bots are logged and flagged but get no cookie.
- Checkout start resolves the link in this order: the `attr` cookie when it names an enabled link **of the same launch**, else `?ref=<code>` (forwarded from `/p/[slug]?ref=`), else none; `metadata.attribution` = `cookie | ref`. At completion a promotion code that belongs to an enabled tracked link of the same launch wins (`attribution = discount_code`); otherwise the metadata link is re-checked. `?code=<DISCOUNT>` on `/p/[slug]` pre-applies a promotion code (`discounts`), else Stripe's page offers the field (`allow_promotion_codes`).
- Discount codes: `createPromotionCode` (percent-off coupon, `duration: once`), idempotency key `promo:<trackedLinkId>`; disabling a link deactivates its code (`tracked_link.disabled`).

**Checkout and orders** (`lib/stripe/checkout-shared.ts` is the parameter contract)
- `POST /p/[slug]/checkout` (route handler, `RATE_LIMITS.checkout` per IP): launch `live` (and for `license_key` at least one unassigned key, else "Sold out"), `orderRef = newId()`, `createCheckoutSession(input, { idempotencyKey: "checkout:<orderRef>" })` with `checkoutSessionParams` (one tax-inclusive line, `automatic_tax`, `tax_code = taxCodeFor(launch)`, metadata on session **and** `payment_intent_data`, `transfer_group = order_<orderRef>`, expires in 30 minutes, success `/p/<slug>/success?session_id={CHECKOUT_SESSION_ID}`, cancel `/p/<slug>`), `checkout.started { tracked_link_id, price_cents, currency }` (actor null), 303 to the session URL.
- **Metadata keys** (`CHECKOUT_METADATA_KEYS`, parsed back with `checkoutMetadataSchema`): `order_ref`, `launch_id`, `tracked_link_id` (only when attributed), `attribution` (`cookie | ref`, with the link). Strings only, never emails.
- **Fulfilment** (`checkout.session.completed` with `payment_status = paid`, or `checkout.session.async_payment_succeeded`; `async_payment_failed` / `expired` record nothing): one transaction in the handler: insert the order with `id = metadata.order_ref` (`ON CONFLICT (stripe_checkout_session_id) DO NOTHING`: replays are no-ops), gross = `amount_total`, tax/discount from `total_details`, buyer email/country from `customer_details`, `paid_at` = the charge's `created` (else the event's), status `paid`; the access grant; a license key (`… FOR UPDATE SKIP LOCKED` on the oldest unassigned; none left → the order still stands, the access page says the key is on its way, members get `launch.license_keys_low { remaining: 0 }`; ≤ 5 left → the same notice, dedupe `launch.license_keys_low:<launchId>:<remaining>`); `order.paid` (with `stripe_fee_cents: 0` when the fee is not known yet). The handler retrieves the PaymentIntent with the balance transaction (`retrievePaymentIntentWithBalanceTransaction`; handlers run inside the webhook's transaction, so this one Stripe read happens there); when the balance transaction exists, `postOrderLedger` runs in the same transaction. `afterCommit`: enqueue `orders/paid.requested { orderId }` (event id `order:<orderId>`).
- `charge.updated` with a `balance_transaction`: find the order by `stripe_charge_id` (else the PaymentIntent id), `retrieveBalanceTransaction` when only an id came, then `postOrderLedger`. The hourly `ledger-post-pending` job catches anything missed (orders unposted after an hour).
- **Access** (`lib/delivery/token.ts`): token = 32 random bytes, base64url, 43 characters; `/access/<token>` (dynamic, `no-store`, `Referrer-Policy: no-referrer`): `file` → the files with 5-minute signed GET URLs (download disposition), `license_key` → the key, `url` → 302 to `delivery_config.url`; revoked (full refund or lost chargeback) → a plain "no longer available" page. Unknown tokens 404. `access.opened` (actor null), rate limited per IP. The success page shows the order state ("processing" until the webhook landed) and the access link (the buyer's own browser just paid); it never shows other orders.
- Delivery types (§5): `file` (`launch_files`, uploaded with the `deliverable` purpose: 200 MB, allow-listed types, `launch-uploads/` then copied to `launch-files/<launchId>/` like §19.19), `license_key` (`license_keys`, pasted one per line, deduplicated per launch), `url` (https only).

**Ledger** (`lib/ledger/types.ts`; `split.ts`, `post.ts`, `release.ts`, `check.ts` are signature stubs for the ledger builder)
- `computeSplit({ grossCents, taxCents, stripeFeeCents, takeRateBps, members })` (pure): `net = gross − tax − stripe_fee`; `platform_fee = round_half_up(net × bps / 10000)` with integer arithmetic (`takeRateBps(PLATFORM_TAKE_RATE)`); when `net ≤ 0`, `platform_fee = net` and members get 0; `distributable = net − platform_fee`; shares by largest remainder over `split_pct` (ties → lower user id, string order); `lines` = `tax`, `stripe_fee`, `platform_fee` (user null) and `creator_share` / `builder_share` per member, zero lines dropped, **sum = gross** (asserted).
- `postOrderLedger(tx, { orderId, balanceTransaction })` → `posted | already_posted`: order locked `FOR UPDATE`; idempotent on `ledger_posted_at`; members and splits from `collab_members` (the signed split, §19.28); every line `available_at = paid_at + HOLD_DAYS`, currency of the order (a balance transaction in another currency is refused: the platform settles in EUR); sets `stripe_fee_cents`, `stripe_balance_transaction_id`, `ledger_posted_at`; `order.ledger_posted`.
- **Refunds** (`postRefundLedger(tx, { refundId })`, on `succeeded` only): mirror lines with `refund_id`, proportional to the order's sale lines, computed on the **cumulative** refunded amount minus what earlier refunds mirrored (so a full refund zeroes every component exactly; largest remainder, ties to platform lines first, then lower user id). The Stripe fee is not returned (§19.10): its share is an `adjustment` (user null) instead of a negative `stripe_fee`. `available_at = max(sale line's available_at, refund time)`, so a refund before payout nets to zero in the same payout. Sum of a refund's lines = −amount. Refused until the sale is posted (`order_not_posted`; posted later by whoever posts the sale). A refund that later fails after succeeding gets the mirror of its mirror (same `refund_id`).
- **Chargebacks** (`postChargebackLedger`, on `lost`): the same mirror for the disputed amount (`chargeback_id`), plus the dispute fee as `stripe_fee +fee` and `adjustment −fee` (the platform absorbs it, decided here like the refund fee in §19.10). Order sums stay `gross − amount_refunded` (lost chargebacks add to `amount_refunded_cents`).
- **Payout batch** (`payouts-release`, daily 06:00 UTC; payouts runs it with the ledger's `payableBalances`): (1) open or resume the batch for `runKey ?? "daily:<UTC day>"` (`cutoff_at` = the run's clock), stop if completed; (2) first resolve any `pending` transfer of earlier batches (`listTransfersByGroup("payout_<transferId>")`); (3) per payouts-ready active user and currency: net of entries with `transfer_id IS NULL`, `available_at ≤ cutoff`, order not `disputed` (negative entries included: refunds after payout net here, §19.10); if ≥ `MIN_PAYOUT_CENTS`, one transaction inserts the `pending` transfer (`ON CONFLICT (batch, user, currency) DO NOTHING`) and marks exactly those entries with its id; (4) one step per transfer: `createTransfer` (no `source_transaction`; `transfer_group = payout_<transferId>`; metadata `transfer_id`, `batch_id`, `user_id`; idempotency key **`payout:<batchId>:<userId>`**) → `created` + `payout.sent` + a required `payout.sent` notice in a following step; `StripeGatewayError` (balance or account refusal) → `failed` + `failure_code` + **release**: for each marked entry a mirror (−amount, same refs, `transfer_id` = the failed transfer) and a re-issue (+amount, `transfer_id` null), so the money is payable again and the failed transfer's entries sum to 0; `payout.failed` + notice. Other errors throw (Inngest retries the step). (5) close the batch with counts, `payout.batch_completed`. Suspended users and users without payouts-ready accounts are skipped (their balance waits).
- **Reversals** (`payouts-reverse`, enqueued from the refund/chargeback handler's `afterCommit`): per member whose sale line of that order was transferred (in transfer T), reverse the member's mirror amount from T: `transfer_reversals` row (`pending`), `createTransferReversal`, idempotency key `reversal:<reversalId>`; success → `succeeded`, T's `amount_reversed_cents` and status (`partially_reversed` / `reversed`), and the mirror line gets `transfer_id = T` (settled); refusal → `failed`, the mirror stays unpaid and is netted by the next payouts. `payout.reversed { succeeded }`. Untransferred members need nothing (their mirror nets in the next batch).
- **Invariants** (`checkLedger`, `pnpm ledger:check`, daily `ledger-check` job): per posted order Σ lines = gross − `amount_refunded_cents`; orders paid > 24 h ago are posted; per transfer Σ lines with its id = amount − reversed (0 for failed); with Stripe: amount, reversed and destination match. Mismatches go to Sentry with ids only.
- `/app/earnings` (payouts) shows per user: pending (posted, not available), available, paid out, and "fee pending" sales; `/app/earnings/payouts` the transfers (`canViewOwnEarnings`).

**Refunds and chargebacks** (payouts)
- A refund started in the app (`canRefundOrder`: admins; Phase 6 UI, v1 buyer requests) inserts the `refunds` row first (`pending`, `requested_by_user_id`), then `createRefund` (idempotency key `refund:<refundId>`, metadata `refund_id`, `order_ref`). Refund events (`refund.created | updated | failed`, `charge.refunded`) upsert by `stripe_refund_id` (else `metadata.refund_id`; a dashboard refund creates the row, `refund.created { source: "stripe" }`), map Stripe's status, and on `succeeded` (once, under the order lock): `postRefundLedger`, `amount_refunded_cents` + status, full refund → revoke the access grant, `order.refunded`; `afterCommit` enqueue `payouts/reverse.requested` and `refunds/succeeded.requested` (buyer confirmation + `order.refunded` notices). `failed` / `canceled` → `refund.failed`.
- `charge.dispute.created`: `chargebacks` row (`open`), order → `disputed` (excluded from payouts), `order.disputed`, `order.disputed` notices to members and `admin.chargeback_opened` to admins (email `dispute-opened.tsx`). `charge.dispute.closed`: `won` → the order's status from its refunded amount again, `chargeback.closed { outcome }`; `lost` → `postChargebackLedger`, refunded amount and status, revoke access when fully lost, enqueue `payouts/reverse.requested { cause: "chargeback" }`.

**Emails** (who, when; buyer emails go through `sendEmail` with an idempotency key, members' through `notify`)
| Email | To | When | Sent by |
|---|---|---|---|
| `buyer-receipt.tsx` (receipt + access link) | buyer | `orders-fulfilled` job after the order commits; required, key `buyer-receipt:<orderId>` | checkout |
| `sale-made.tsx` (`sale.made`) | both members | same job; dedupe `sale.made:<orderId>:<userId>` | checkout |
| `notification.tsx` (`launch.approval_requested`, `launch.rejected`, `launch.live`, `launch.paused`, `launch.license_keys_low`, `admin.launch_review_requested`) | members / admins | on the transition, after the commit | launch / checkout (keys) |
| `payout-sent.tsx` (`payout.sent`, required) | the user | after the transfer is `created` | payouts |
| `notification.tsx` (`payout.failed`, required) | the user | after a refused transfer | payouts |
| `refund-confirmation.tsx` | buyer | `refunds-notify` job; required, key `refund-confirmation:<refundId>` | payouts |
| `notification.tsx` (`order.refunded`, required) | both members | same job | payouts |
| `dispute-opened.tsx` (`admin.chargeback_opened`) + `notification.tsx` (`order.disputed`, required) | admins / members | after `charge.dispute.created` commits | payouts |
- "Required" (`REQUIRED_EMAIL_REASONS`): money records ignore the email preference (Settings shows why). Callers pass `email.required: true` for those types and call `notify` in a job step after the money transaction, never inside it (a required email's failure throws). Admin-only types (`ADMIN_NOTIFICATION_TYPES`) are listed in Settings for admins only.

**Registries filled here**
- Events beyond §11 (subjects `refund`, `chargeback`, `payout_batch` added): `launch.created`, `launch.updated { fields, approvals_reset }`, `launch.rejected`, `launch.resumed { by }`, `launch.ended { by }`, `tracked_link.created { is_default, has_discount }`, `tracked_link.disabled`, `order.ledger_posted { stripe_fee_cents, platform_fee_cents, entry_count }`, `access.opened { delivery_type }`, `refund.created { source }`, `refund.failed`, `chargeback.closed { outcome }`, `payout.failed { failure_code }`, `payout.reversed { cause, succeeded }`, `payout.batch_completed`. Buyers have no account: their events have actor null and never carry the email or the access token.
- Notification types: `launch.approval_requested | rejected | live | paused | license_keys_low`, `admin.launch_review_requested`, `sale.made`, `payout.sent | failed`, `order.refunded | disputed`, `admin.chargeback_opened` (groups Launches, Money, Admin; links to the launch page, `/app/launches/<id>/kit`, `/app/earnings`, `/app/earnings/payouts`, `/app/settings/payouts`, `/admin/launches`, `/admin/payouts`; amounts in integer cents).
- Jobs (registered with `notBuiltYet` handlers answering `{ skipped: true, reason: "not_implemented" }`; run one with `POST /api/test/jobs/<id>`):

| Job id | Event | Trigger | Owner |
|---|---|---|---|
| `orders-fulfilled` | `orders/paid.requested { orderId }` | `afterCommit` of fulfilment, id `order:<orderId>` | checkout |
| `ledger-post-pending` | `ledger/post-pending.requested {}` | cron hourly :20 | ledger |
| `payouts-release` | `payouts/release.requested { runKey? }` | cron 06:00 UTC; admin run `manual:<uuid>` | payouts |
| `payouts-reverse` | `payouts/reverse.requested { cause, id }` | `afterCommit` of a succeeded refund / lost chargeback, id `reverse:<cause>:<id>` | payouts |
| `refunds-notify` | `refunds/succeeded.requested { refundId }` | `afterCommit` of a succeeded refund | payouts |
| `ledger-check` | `ledger/check.requested {}` | cron 07:15 UTC | payouts (runs `checkLedger`) |

- Authorization (`lib/auth/authz.ts`, unit-tested): `EDITABLE_LAUNCH_STATUSES` is now `draft | pending_approval | admin_review | paused`; `LaunchAccess` = members + `status` + `collabStage`; `canViewLaunchSetup`, `canEditLaunch`, `canApproveLaunch`, `canReviewLaunch`, `canPauseLaunch`, `canResumeLaunch`, `canEndLaunch`, `canCreateTrackedLink` (members of a live/paused launch), `canManageTrackedLink` (its owner), `canViewOwnEarnings`, `canViewLaunchOrders`, `canRefundOrder` (admin), `canManagePayouts` (admin). Admins never act as a party.
- Rate limits: `RATE_LIMITS.redirect` (`/r/*`, product-page views), `RATE_LIMITS.checkout`; area buckets at the call site (`launch-kit` 10/h per user, `access` 60/min per IP, `launch-file-upload` 20/h per user).
- Nav: `LAUNCH_ROUTES` (`/app/launches`, `/admin/launches`) and `EARNINGS_ROUTES` (`/app/earnings`, `/app/earnings/payouts`) are empty lists the owners fill when their pages exist; tabs, Me, menus and home cards follow (§19.19, §19.20). The collab page links to `/app/collabs/[id]/launch`; `/app/collabs/[id]/analytics` and `/app/launches/[id]/links` are Phase 7.
- Seed: steps `launches` (launch: collab 03 → live launch with its default link) and `orders` (checkout: paid orders through the real fulfilment and ledger path, so `pnpm ledger:check` has data) are registered as placeholders after `collabs`.

**Other pieces written here:** `lib/launches/status.ts`, `lib/attribution/cookie.ts`, `lib/delivery/token.ts`, `lib/ledger/split.ts` (`takeRateBps`), Settings → Notifications per-type required reasons and admin filtering, notification icons for launch and money. Tests: `tests/integration/db/w3-constraints.test.ts`, `tests/integration/stripe/after-commit.test.ts`, `tests/unit/stripe/w3-contracts.test.ts` (session parameters, metadata, tax codes, object schemas), `tests/unit/w3/contracts.test.ts` (status machine, cookies, tokens, take rate), plus the catalog tests (events, notifications, jobs, authz).

**Open questions for Trifon** (decided by delegation for now, revisit before real money): the platform absorbs dispute fees like refund fees; launches are priced in EUR only; a live launch must be paused to be edited; only admins end launches and refund orders in the MVP.

### 19.32 Phase 4: launches, tracked links, product page, launch kit
Built on the §19.31 contracts; no schema change was needed.

**Files**
- `lib/launches/`: `fields.ts` (client-safe: limits, slugs, the setup form schema, `deliveryConfigFor`, `missingForApproval`, license-key parsing, upload policy and keys, media helpers, status texts), `queries.ts`, `service.ts` (create, save, approve, admin approve/reject, pause, resume, end; `lockLaunch`, `recordEdit`, `endLaunchInTx` for Phase 6), `content.ts` (files, images, license keys), `tracked-links.ts` (`ensureDefaultTrackedLink`, `trackedLinkPath`), `notifications.ts`, `kit.ts`, `media.ts`, `page-view.ts`, `revalidate.ts`, `actions.ts`. `status.ts` is §19.31's.
- `lib/attribution/`: `code.ts` (8-char base62 codes, rejection sampling), `bots.ts`, `request-context.ts` (country header, referrer origin, keyed UA hash), `click.ts` (`/r/[code]`), `resolve.ts` (`resolveCheckoutAttribution` for the checkout builder). `cookie.ts` is §19.31's.
- Prompt `lib/ai/prompts/launch-kit.ts` (`launch_kit@v1`, with `fake`) + client-safe `launch-kit-shared.ts`. Gateway `lib/stripe/{live,fake}-promotions.ts`.
- Pages: `/app/collabs/[id]/launch` (+ `loading.tsx`), `/app/launches` (+ `loading.tsx`), `/app/launches/[id]/kit`, `/admin/launches`, `/p/[slug]` (+ `layout.tsx`, the site chrome for checkout/success too). Route handlers: `app/r/[code]/route.ts`, `app/p/[slug]/view/route.ts` (the §19.31 beacon), `app/api/launches/[launchId]/media/[name]/route.ts` (images). UI in `components/launches/`. `LAUNCH_ROUTES` lists `/app/launches` and `/admin/launches`; the collab section nav gained "Launch" (`components/collabs/collab-nav.tsx`, `collab-header.tsx`), and the collab overview links `launch_review` / `live` collabs to it.
- Seed step `lib/seed/launches.ts` (collab 03 live; creates `seed-admin@example.com` with the admin role through `registerUser`, to approve it in review the real way).

**Lifecycle details (decided here, within §19.31)**
- A member starts the launch from the Launch tab ("Set up the launch"); nothing is created by visiting the page. Title = the idea's or product's (≤ 120), slug = its slug, else `-2`…`-10`, padded when shorter than 3 (`baseSlug`).
- Save compares every column with sorted-key JSON (`jsonb` returns objects in its own key order) and resets approvals only when something changed; a no-op save changes nothing. `tax_code` is stored on save from the delivery type (`DEFAULT_TAX_CODES`), so the approved version records it.
- Approve checks completeness under the lock (`missingForApproval`; the error names what is missing). With `AUTO_APPROVE_LAUNCHES`, the second approval writes `pending_approval` first and then goes live in the same transaction, so the collab passes `building → launch_review → live` and `submitted_at` holds. The first approval clears an old `review_note`; a rejection keeps it on the page until then.
- **Resume always needs both members' approvals of the current version** (stricter than §19.31, which required them only for member pauses): an edit made while an admin's pause was on would otherwise go live unreviewed by the members. Who may resume is still `canResumeLaunch`.
- Admins act only through `/admin/launches` (approve, send back with a note, pause, resume, end), each written to `admin_audit_log` (`launch.approved | rejected | paused | resumed | ended`). Admins read the setup page; they never approve as a party.
- Notices: `launch.approval_requested` to the member who has not approved (dedupe per submission), `admin.launch_review_requested` to every active admin, `launch.rejected` and `launch.live` (once per launch) to both, `launch.paused` to the other member (a member's pause) or both (an admin's). `launch.resumed` sends none (the catalog has no type).
- Going live also asks for the idea's (and an exclusive product's) embedding refresh after the commit: their status left matching's candidates.

**Content (decided here)**
- Files and images are launch content: adding or removing one resets approvals like a save (`launch.updated { fields: ["launch_files" | "media"] }`). **License keys are stock**: members add pasted keys (one per line, ≤ 1,000 per paste, deduplicated against the launch) or remove all unassigned keys in any status but `ended`, without resetting approvals, so a live launch can be restocked (`license_keys_low` links here). Events: `launch.updated { fields: ["license_keys"], approvals_reset: false }`.
- Files need delivery type `file` saved first; ≤ 20 files, 200 MB each (§14 deliverable allow-list). Images: ≤ 6, 10 MB, PNG/JPEG/WebP/GIF, optional alt text (default "<title>, image n"), stored in `launches.media` as `{ kind: "image", url: <storage key>, alt }`. Uploads use one bucket, `launch-file-upload` (20 signed URLs per member per hour), for both. A removed file disappears from existing buyers' access pages too (only possible while paused or before going live).
- Images are served by `/api/launches/<id>/media/<name>` (302 to a 10-minute signed URL; public once the launch is public, members and admins before). Pages use `launchMediaPath`, never the key.

**Tracked links and `/r/[code]`**
- Codes: 8 characters from the CSPRNG, bytes ≥ 248 dropped so each of the 62 characters is equally likely; a code collision retries (5 attempts).
- **Deviation from §19.31's "disabled → 404":** a disabled link still redirects to the product page (old posts keep working, as the schema comment says) but logs nothing, sets no cookie and adds no `?ref=`. Links of launches that are not public (never live) answer the plain 404 page.
- The redirect target is `absoluteUrl("/p/<slug>")` plus `?ref=<code>` (the checkout's fallback when the cookie is blocked) and `?code=<DISCOUNT>` when the link has a discount code. Responses are `no-store`, `Referrer-Policy: no-referrer`, `noindex`.
- Cookies are set before the rate-limit check: over the `redirect` limit (120/min per IP) a person still gets redirected and attributed, only the log row is skipped. Bots: no cookies, `is_bot` row. `vid` is issued once; `attr` is rewritten on every click (last click wins).
- `link_clicks`: `referrer` = origin only, `country` from `x-vercel-ip-country` / `cf-ipcountry` (XX and T1 dropped), `ua_hash` = HMAC-SHA256 of the UA under a key derived from `AUTH_SECRET` (32 hex), `visitor_id` = `vid`. Event `link.clicked` (actor null) with context `{ ip_country, ua_hash }`. Bot detection (`isBotUserAgent`): crawlers, link-preview fetchers (Facebook, WhatsApp, Telegram, Slack, Discord, X, LinkedIn…), AI crawlers, headless browsers, HTTP libraries, and an empty UA.
- Discount codes and the links page are Phase 7 (`/app/launches/[id]/links`, v1). The promotion-code gateway is built: live = a `percent_off` coupon (`duration: once`) plus `promotionCodes.create({ promotion: { type: "coupon", coupon } })` (endive), keys `<key>:coupon` / `<key>:code`; fake = `promo_fake_` / `fake_coupon_` ids from the key, replay, `invalid_request` for a reused key with other parameters or a second active code with the same text.

**Product page `/p/[slug]`**
- Static: `generateStaticParams` returns none (rendered on first visit), `revalidate = 3600` as a safety net, and `revalidateLaunchPage` after going live, pause, resume, end and edits of a paused launch. It reads no cookies or headers. Public only for `live | paused | ended` with a price and delivery type; members' names and handles come from their profiles for their role and only while the person is active.
- Shows the title, tagline, "by @creator × @builder" (links to `/c/` and `/b/`), images, the description through `MarkdownText` (sanitized), the price with "One-time payment. Price includes VAT where it applies.", and the delivery line. Paused: "Not available right now"; ended: "No longer available" (status 200, `noindex`).
- **Buy** is a plain `POST` form to `/p/<slug>/checkout` (the checkout builder's route handler); on submit it copies `ref` and `code` from the address bar into the form's own query string (`checkoutAction`, only `[A-Za-z0-9]{1,40}` values), since the static page cannot read them. Until the checkout route exists the button answers 404/405.
- The view beacon posts once per browser session (`sessionStorage` `pv:<slug>`, in try/catch). The route skips bots, rate-limits per IP (`redirect` bucket), records `product_page.viewed { tracked_link_id }` (the `attr` link only when it belongs to this launch; actor null, context `{ ip_country, ua_hash }`) and always answers 204.

**Launch kit**
- `/app/launches/[id]/kit` is for the collab's members (admins get a 404: it is a promotion tool) once the default link exists; before that it explains. It shows the creator's tracked link (copy button) and "Write posts": 3 posts for each of the creator's connected YouTube / Instagram / TikTok accounts (all three when none is connected).
- Input: title, tagline, description (≤ 1,500 characters), price label, delivery kind, the creator's niche, topics and summary, the link; user text inside `<untrusted_content>`. Output Zod-checked (one retry, fallback; requested platforms only, in order); a post without the link gets it appended (`withLink`). `ai.generated` (subject `launch`, actor the member, `accepted_by_user: null`). Rate limit `launch-kit` 10/h per member.
- **Kits are not stored** (no column; no schema change in this wave): each generation is shown once in the page; generating again writes new drafts. No `ai.reviewed` is recorded for copies (open item).

**Lists**
- `/app/launches`: the user's launches (live first), with price and, once live, non-bot link clicks, product page views (`product_page.viewed` events) and sales (`orders` count and gross minus refunds). Each opens the collab's launch setup; live ones link to the kit.
- `/admin/launches`: tabs To review (oldest submission first) / Live / Paused, each card with members, price, delivery, images, the description (collapsible), and the actions.

**Tests:** unit `tests/unit/launches/fields.test.ts` (slugs, form, completeness, keys, uploads, status machine as used), `attribution.test.ts` (codes, bot list, the Buy form's forwarding), `launch-kit.test.ts`, `tests/unit/stripe/promotions.test.ts`; integration `tests/integration/launches/launches.test.ts` (start, save resets approvals, completeness, dual approval → review, auto-approve, admin approve with every go-live side effect, send back, pause/resume rules, files/images/keys, actions with field errors and strangers), `attribution.test.ts` (`/r` logging, cookies, bots, disabled, rate limit, 404s; checkout attribution; public loader; view beacon; images; kit and its fallback), `seed.test.ts`; e2e (written, run at the gate) `tests/e2e/launches.spec.ts` (both approve → admin approves → `/p/<slug>` live → tracked link sets the cookie and logs; kit; pause; outsiders 404) and `tests/e2e/mobile-launches.spec.ts` (phone: 16 px fields, Save above the tabs, 44 px actions, no sideways scroll on the setup page, launches list, admin queue and product page).

**Open items**
- `in_collab → launched` for non-exclusive products never happens (they stay `seeking`, §19.24); ending a launch when its collab ends is Phase 6 (`endLaunchInTx(tx, state, { by: "collab_ended" })`).
- Abandoned uploads in `launch-uploads/` (dialog closed before adding) are not swept (same TODO as portfolio and message uploads).
- `/p/[slug]` has no Open Graph image route of its own: the first image's media URL is used, which redirects to a signed URL some crawlers may not follow.

### 19.33 Phase 5: ledger core (split, mirrors, posting, balances, reconciliation, money gateway)
(Written by the ledger builder; §19.31 is the contract. No schema change.)

**Files:** `lib/ledger/allocate.ts` (the one rounding rule), `split.ts`, `refund.ts` (pure, client-safe), `errors.ts` (`LedgerError` with a `code`), `post.ts`, `release.ts`, `pending.ts`, `check.ts` (server), `types.ts`; `scripts/ledger-check.ts`; `lib/stripe/{live,fake}-money.ts`; job `inngest/functions/ledger-post-pending.ts`.

**Rounding** (`allocateLargestRemainder(total, weights, denominator)`): exact integer floor division (negative weights included), leftover cents one each to the largest remainders, ties to the earlier weight. Callers order weights by their tie-break. Parts sum to the total, each within a cent of exact, never past its weight nor of the wrong sign.

**Split** (`computeSplit`, §19.31 formula): members are validated (≥ 1, distinct ids, integer 0–100, sum 100) and sorted by user id (plain string order) before allocating, so the input order never matters. `tax + fee > gross` gives a negative `platform_fee` line (the platform carries the loss), members 0; a free order writes no lines. Lines: tax, stripe_fee, platform_fee, then members by user id; zero lines dropped; sum asserted (`sum_mismatch`).

**Refund mirrors** (`computeRefundMirror`; deviation in wording from §19.31, same intent)
- Components = the order's sale lines per (account, user). A refund's part per component = largest-remainder split of the **cumulative** refunded amount over the sale lines (ties: tax, Stripe fee, platform fee, then lower user id) minus what that component already gave back, **clamped to `[0, what is left]`** (never past zero, never the wrong way: plain Hamilton can move a component backwards when the total grows, the Alabama paradox). Cents moved by the clamp go one at a time to the component furthest behind (ahead) its exact cumulative share. A refund of everything left gives each component exactly its remainder, so a full refund zeroes every component.
- Property-tested (1000 runs each): refund lines sum to −amount; the order sums to gross − refunds; no over-reversal; members only ever give back; full refunds zero every account; cumulative reversals within two cents of exact (one in every run so far); over-refunds refused (`over_refund`).
- The Stripe-fee component is reversed as `adjustment` (user null), never a negative `stripe_fee` (§19.10). Chargebacks add `stripe_fee +fee` / `adjustment −fee`.
- "Already given back" is read from the stored lines (`componentsFromEntries`): lines with a refund or chargeback id; `adjustment` and `stripe_fee` cause lines both count toward the Stripe-fee component, so a dispute-fee pair cancels out. Lines without a cause and of account `adjustment` (e.g. a Phase 6 admin adjustment on an order) are not sale components and are never mirrored.

**Posting** (`post.ts`; all inside the caller's transaction, lock order: **order first**, then the refund/chargeback, so the payouts handlers must lock the order before the refund too)
- `postOrderLedger(tx, { orderId, balanceTransaction }, config?)`: also refuses a balance transaction whose `amount` ≠ the order's gross (`balance_transaction_mismatch`, decided here) or another currency. `config` defaults to `ledgerConfigFromEnv()` (`PLATFORM_TAKE_RATE`, `HOLD_DAYS`); tests pass it explicitly. After the sale it posts any succeeded refunds and lost chargebacks of the order that were waiting (`order_not_posted` earlier).
- `postRefundLedger` (status `succeeded` only, else `invalid_state`) and `postChargebackLedger` (`lost` only): `available_at = max(sale's available_at, now)`. They do **not** touch `orders.amount_refunded_cents` / status: the payouts handlers update them in the same transaction (the check fails otherwise).
- New: `reverseRefundLedger(tx, { refundId })` for a refund that fails after succeeding (§19.31 "mirror of its mirror"): negates its lines (same `refund_id`), idempotent (`already_reversed` when they net to 0, `nothing_to_reverse` when never posted). The handler also subtracts the amount from `amount_refunded_cents`.
- Free orders (gross 0, e.g. a 100 % discount: no PaymentIntent, no balance transaction) cannot be posted under the `orders_ledger_needs_balance_transaction` check. Open item for checkout: skip the ledger for them, or a schema change.

**Balances** (`release.ts`)
- `payableBalances(db, { cutoffAt, minPayoutCents, userId? })` locks the entries (`FOR UPDATE OF ledger_entries`) and returns per (user, currency) `{ amountCents, entryIds, stripeAccountId }` (field added to `PayableBalance` so payouts has the destination). Nets ≤ 0 are never returned, whatever the minimum. Entries without an order count (admin adjustments).
- New: `releaseFailedTransferEntries(tx, { transferId })` implements §19.31 step 4's release (the transfer must already be `failed`; mirror with the transfer id + re-issue with none; idempotent). Payouts calls it instead of writing lines itself.
- New: `userBalances(db, { userId, at })` → per currency `pendingCents`, `availableCents`, `onHoldCents` (disputed), `paidOutCents`, for `/app/earnings`.

**Reconciliation** (`checkLedger(db, { compareWithStripe, gateway, at, postingGraceHours })`, read-only): orders (posted: gross − refunded; unposted: 0 entries; unposted after 24 h: `order_not_posted`), refunds (`refund_sum`: −amount while succeeded and posted, 0 once failed/canceled or unposted), lost chargebacks (`chargeback_sum`), transfers (amount − reversed; 0 when failed) and, with Stripe, every created/reversed transfer found through `listTransfersByGroup("payout_<id>")` (amount, amount reversed, currency, destination; `missing at Stripe`). Mismatch kinds `refund_sum` / `chargeback_sum` and fields `refundId`, `chargebackId`, `detail` were added to `LedgerCheckMismatch`. `formatLedgerReport` prints ids and amounts only. `pnpm ledger:check [--no-stripe]` prints it and exits 1 on any mismatch (fake store when Stripe is fake). The daily `ledger-check` job (payouts) should call `checkLedger(getDb(), { compareWithStripe: true, gateway: getStripeGateway() })` and report mismatches.

**`ledger-post-pending`** (`postPendingOrders`): unposted orders paid ≥ 1 h ago, keyset pages of 100 by `(paid_at, id)`, one transaction each; counts `posted | waiting | skipped (no PaymentIntent) | failed` (reported with the order id); the step throws when any failed so Inngest retries.

**Money gateway**
- Live: `transfers.create` (no `source_transaction`), `transfers.list({ transfer_group })` auto-paginated, `transfers.createReversal`, `refunds.create` / `retrieve`, `disputes.retrieve`, `balanceTransactions.retrieve`; every response Zod-parsed. Stripe `resource_missing`, `balance_insufficient`, `charge_already_refunded` map to those `StripeGatewayError` codes, `insufficient_funds` (a connected account short for a reversal) to `balance_insufficient`, other invalid requests to `invalid_request`; API, auth and network errors pass through (callers retry).
- Fake: ids from the idempotency key (`tr_fake_`, `trr_fake_`, `re_fake_` + sha256), replayed, `invalid_request` for the same key with other parameters. `FakeObjectType` gained `balance` (one line in `lib/stripe/fake.ts`): the platform balance is unlimited until `setFakePlatformBalance` sets it (then transfers above it fail with `balance_insufficient`); each connected account's balance grows with transfers and shrinks with reversals, and `drainFakeConnectedBalance` simulates Stripe paying it to the bank so the next reversal fails with `balance_insufficient`. Transfers need an existing fake account with `transfers: active` (`resource_missing` / `invalid_request` otherwise), so tests and seeds must create fake accounts through the gateway (`completeFakeOnboarding`). Refunds succeed at once against the PaymentIntent's `latest_charge` (the fake checkout's `payment_intent` / `charge` objects; `amount_refunded` tracked on the charge, `charge_already_refunded` when nothing is left) with a `refund` balance transaction. The gateway never posts webhooks itself (the caller may hold the order lock the handler needs): after its commit the caller calls `deliverFakeRefundEvent(store, refundId, "refund.created" | "refund.updated" | "refund.failed", { url, secret })`; `settleFakeRefund` fails or cancels a refund later; `createFakeDispute` / `closeFakeDispute` (dispute fee `FAKE_DISPUTE_FEE_CENTS` = 1500) plus `deliverFakeStripeEvent` drive chargebacks.

**Tests:** unit `tests/unit/ledger/split.test.ts`, `tests/unit/ledger/refund.test.ts` (fast-check, 1000 runs per property), `tests/unit/stripe/money.test.ts` (fake against a temp store; live against a stubbed HTTP layer); integration `tests/integration/ledger/post.test.ts` (post twice/racing → one set, mismatches write nothing, waiting refunds, append-only, partial and full refunds, failed-after-succeeded, chargebacks, a 25-run DB property with `checkLedger` clean) and `balances-check.test.ts` (payable balances and their exclusions, failed-transfer release, `userBalances`, every mismatch kind, Stripe comparison with the fake, `postPendingOrders`).

### 19.34 Phase 4: checkout, orders, delivery, buyer access
(Written by the checkout builder; §19.31 is the contract. No schema change.)

**Files:** `lib/checkout/` (`start.ts` the Buy route's logic, `success.ts` the success page's state, `html.ts` the refusal page, `fake-page.ts` the fake Stripe Checkout page, `fake-purchase.ts` a browserless purchase for the seed and tests), `lib/orders/` (`fulfil.ts`, `queries.ts`, `emails.ts`), `lib/delivery/access.ts` (`token.ts` is §19.31's), `lib/stripe/{live,fake}-checkout.ts`, `lib/stripe/handlers/checkout.ts`, `lib/email/templates/{buyer-receipt,sale-made}.tsx`, job `inngest/functions/orders-fulfilled.ts`, seed step `lib/seed/orders.ts`. Routes: `app/p/[slug]/checkout/route.ts`, `app/p/[slug]/success/page.tsx`, `app/access/[token]/{layout,page}.tsx`, `app/access/[token]/files/[fileId]/route.ts`, `app/api/dev/fake-stripe/checkout/[sessionId]/route.ts`.

**Checkout route** (`POST /p/<slug>/checkout`, the §19.31 steps)
- Refusals answer a small standalone HTML page with "Back to the product" (a route handler cannot render the app's pages; buyers have no account to redirect to): unknown slug 404, not `live` 409 "Not available right now", license-key launch without unassigned keys 409 "Sold out", over `RATE_LIMITS.checkout` 429 with `Retry-After`, gateway failure 502. Each says "Nothing was charged". `GET` (reload, shared link) answers 303 to the product page.
- `?code=` (case-insensitive) pre-applies the promotion code only when it is the discount code of an enabled link of this launch with a `stripe_promotion_code_id`; otherwise the session allows typed codes.
- `successUrl` is built by string concatenation so Stripe's literal `{CHECKOUT_SESSION_ID}` is not URL-encoded. `checkout.started` is written after the session exists (a failed Stripe call records nothing), with context `{ ip_country, ua_hash }`.

**Fulfilment** (`fulfilCheckoutSession`, in the webhook transaction)
- Fulfilled payment states: `paid` **and `no_payment_required`** (a 100% discount: no PaymentIntent, gross 0; decided here so such a buyer still gets access). `unpaid` (a delayed method) does nothing until `async_payment_succeeded`; `async_payment_failed` and `expired` are handled as no-ops, so they are acknowledged as processed.
- A session without our metadata (another integration on the same Stripe account) or for an unknown launch is reported and ignored (`processed`, not retried forever). A paid session without `amount_total`, currency or customer email throws (the event fails and Stripe retries).
- Buyer email is trimmed and lowercased; `buyer_country` only when it is two letters. `paid_at` = the charge's `created`, else the event's (free orders).
- Duplicate protection: a lookup by session id, then `INSERT … ON CONFLICT DO NOTHING` (unique session id and primary key), so replays and racing deliveries create one order, one grant, one `order.paid`, one ledger.
- License keys: `FOR UPDATE SKIP LOCKED` on the oldest unassigned key, then a conditional update. Out of stock: the order stands (`licenseKey: "out_of_stock"`). **Decided here:** the buyer gets the next key added later on their next visit to `/access/<token>` (`claimWaitingLicenseKey`, under the order's row lock, so two visits assign one key); no admin notification type exists for this, so the "admin alert" is a Sentry error (`alert: license_keys_out`) from the job.
- Ledger: posted in a savepoint when the balance transaction exists. `currency_mismatch`, `balance_transaction_mismatch` and `invalid_members` are reported and leave the order unposted (`ledger:check` flags it after 24 h) so the buyer still gets the order; other `LedgerError`s (bugs) fail the event. Free orders (gross 0) are never posted.
- `charge.updated` (`postLedgerForCharge`): order by `stripe_charge_id`, else by PaymentIntent (then the charge id is recorded); posted orders, pending fees and charges without an order yet (it arrived before `completed`) are no-ops.

**`orders-fulfilled`** (`sendOrderEmails`, three job steps): `buyer-receipt` (sent with `sendEmail` directly, buyers have no account; idempotency key `buyer-receipt:<orderId>`; a failure throws and the step retries; no access link once the grant is revoked), `sale-made` (`sale.made` to each member with `sale-made.tsx`: the buyer's total, the member's split, the hold period; "through your tracked link" / "through <creator>'s link" when attributed), `license-keys` (≤ 5 left → `launch.license_keys_low` to both members, dedupe per remaining count, so 0 is sent once even when several orders run out).

**Success page** (`/p/<slug>/success?session_id=`): the order of that session **and** that launch only. States: `paid` (reference = the order id's last 8 hex characters: the first ones are UUIDv7's timestamp), `finishing` (Stripe says paid, webhook not processed: `SyncRefresher` reloads every 2 s), `processing` (delayed method), `failed` (the PaymentIntent needs a new method), `unpaid` (with "Continue to payment" while open), `expired`, `not_found` (malformed or unknown id, another launch's session). If Stripe cannot be reached it assumes `finishing`. `referrer: no-referrer` and `noindex`.

**Access** (`/access/<token>`)
- Dynamic (`headers()`), rate limited per IP (`access`, 60/min), `noindex`, `<meta name="referrer" content="no-referrer">` from the layout (pages cannot set response headers; the meta tag keeps the token out of `Referer` for every link and download), the site's header and footer.
- **Deviation:** files are not listed as pre-signed URLs; each Download links to `GET /access/<token>/files/<fileId>`, a redirect route that answers 302 to a fresh 5-minute signed URL (download disposition) per click, so a page left open never holds an expired link. 404 for revoked or unknown tokens, other launches' files, malformed ids and non-file deliveries.
- License keys with a 44 px copy button and the launch's instructions; URL deliveries `redirect()` to `delivery_config.url` (Next answers 307 from a page, not 302). Every working visit writes `access.opened` (actor null, no token or email). Revoked → "This purchase is no longer available"; unknown → 404.

**Fake Stripe Checkout** (`/api/dev/fake-stripe/checkout/<sessionId>`, 404 unless Stripe is fake)
- The page shows the line, any discount, the VAT included (Spain's rate before the buyer picks a country), the total, email, country (ES, DE, FR, IT, NL, IE, GB, US), a promotion-code field when allowed (codes are looked up among the fake store's active promotion codes), and buttons: "Pay with test card 4242", "Pay by card (fee settles later)", "Pay with delayed method (SEPA debit)", "Delayed method that fails", "Cancel and go back". 16 px fields, 44 px buttons, safe-area padding.
- Tax: a fake VAT table by country (standard EU rates, GB 20 %, others 0; inclusive, integer half-up). Fee: `FAKE_STRIPE_FEE` 1.5 % + €0.25 half up (€19 → 54 cents). Session ids derive from the idempotency key; `fake_*` fields on the stored session carry what the page needs (`success_url`, `cancel_url`, the line, PaymentIntent metadata, transfer group). Open sessions turn `expired` when read after `expires_at`.
- Paying delivers, signed with the **platform** secret, to `absoluteUrl("/api/webhooks/stripe")` over HTTP: card → `checkout.session.completed`; fee later → `completed`, then the balance transaction is written and `charge.updated`; delayed → `completed` (unpaid) at once and, 1.5 s after the redirect (`after()`), `async_payment_succeeded` / `_failed`. Then 303 to `success_url`.
- `fakePurchase` + `deliverDirectly(db)` run the same steps in-process through `processStripeEvent` (seed, integration tests).

**Seed** (`orders`): three purchases of creator 03's live launch through `fakePurchase` and the real webhook processing (ES card attributed, DE card unattributed, FR card with the fee arriving by `charge.updated`); idempotent per buyer email `seed-buyer-0n@example.com`; skipped when Stripe is live. A partially refunded seed order is the payouts area's to add.

**Shared files touched:** `tests/integration/stripe/webhooks.test.ts` used `checkout.session.completed` as its "type without a handler"; it now uses `customer.created` (`unhandledEvent()`).

**Tests:** unit `tests/unit/stripe/checkout.test.ts` (tax and fee arithmetic, fake sessions, payments, expiry, live request shape and error mapping); integration `tests/integration/checkout/checkout.test.ts` (route: session parameters, cookie/ref/other-launch attribution, `?code=`, refusals, rate limit; fulfilment with ledger, events without PII, receipt and sale notices; replayed and duplicate events; unpaid, async success and failure; fee pending then `charge.updated` twice; disabled link at completion; typed promotion code wins as `discount_code`; the last key raced by two orders, the restock claimed once; access files, foreign files, revoked grants, URL targets; success page states; the fake page over the real webhook route) and `seed.test.ts` (three orders, idempotent, `checkLedger` clean); e2e (written, run at the gate) `tests/e2e/checkout.spec.ts` (§16 Phase 4: `/r/<code>` → Buy → fake checkout → success → access and the receipt's link; Sold out) and `tests/e2e/mobile-checkout.spec.ts` (the same path at 390 and 360 px).

**Open items**
- Free orders (`no_payment_required`) have no balance transaction, so they stay unposted and `checkLedger` reports them as `order_not_posted` after 24 h; the ledger owner should skip gross-0 orders there (or a schema change).
- No email when a delayed payment fails (the buyer sees it on the success page if they return).
- `inngest/functions/not-built.ts` was removed by the payouts builder once nothing imported it.

### 19.35 Phase 5: payouts, refunds, chargebacks, earnings
(Written by the payouts builder; §19.31 is the contract, §19.33 the ledger it calls. No schema change.)

**Files:** `lib/payouts/` (`release.ts` the batch, `reverse.ts` transfer reversals, `external-reversals.ts` `transfer.reversed`, `notifications.ts` payout notices, `ledger-check.ts`, `earnings.ts` page data, `failure-codes.ts` client-safe wording, `steps.ts` the `StepRunner` type and `inlineSteps`), `lib/refunds/` (`status.ts` pure rules, `apply.ts`, `request.ts`, `notify.ts`, `context.ts`), `lib/chargebacks/` (`apply.ts`, `notify.ts`), handlers `lib/stripe/handlers/{refunds,disputes,transfers}.ts`, jobs `payouts-release`, `payouts-reverse`, `refunds-notify`, `ledger-check`, emails `payout-sent.tsx`, `refund-confirmation.tsx`, `dispute-opened.tsx`, pages `/app/earnings` and `/app/earnings/payouts` (+ `loading.tsx`, `components/earnings/earnings-nav.tsx`), `EARNINGS_ROUTES` in lib/nav.ts. `inngest/functions/not-built.ts` was deleted (nothing imports it any more).

**Payout batch** (`runPayoutBatch`, §19.31 steps 1–5; steps `open-batch`, `collect`, `pay:<transferId>`, `notify:<transferId>`, `close-batch`)
- `open-batch` fixes the run key (`daily:<UTC day>` of the job's clock unless given) and `cutoff_at` in a memoised step, so an Inngest replay on another day resumes the same batch. A completed batch answers `already_completed`.
- `collect` reads the payable users once, then per user one transaction: `payableBalances(tx, { userId })` (locks the entries), the `pending` transfer (`ON CONFLICT (batch, user, currency) DO NOTHING`) and exactly those entries marked; a count mismatch throws (rolls back). It returns **every** `pending` transfer, earlier batches' first, so a crashed run's leftovers are paid by the next run (§19.31 step 2).
- `pay`: `listTransfersByGroup("payout_<transferId>")` first (finds a transfer whose idempotency key expired), else `createTransfer` with `payout:<batchId>:<userId>` (decided here: `:<currency>` is appended for a non-EUR transfer, so two currencies in one batch never share a key). Success → `created` + `payout.sent { amount_cents, currency, entry_count }` (actor null). A `StripeGatewayError` → `failed` + `failure_code` + `releaseFailedTransferEntries` + `payout.failed`; `balance_insufficient` (the platform's balance) is also reported to Sentry. Other errors throw (the step retries; nothing was marked).
- `notify`: `payout.sent` (payout-sent.tsx) or `payout.failed` (notification.tsx), required emails, dedupe `payout.sent:<id>` / `payout.failed:<id>`, in their own step after the money transaction.
- `close-batch`: counts (`created`, `partially_reversed` and `reversed` count as paid), `completed`, `payout.batch_completed` once. The `failed` batch status is never used: one refused transfer does not fail the batch.
- Each user is one `step.run` for the Stripe call, so a very large batch approaches Inngest's step limit (1,000 per run); revisit (fan out per user) beyond a few hundred payees.

**Reversals** (`payouts-reverse`; `planReversals` + `executeReversal`)
- Plan (one transaction): per member, the sum of their **unpaid** mirror entries of this refund/chargeback; when their sale entry of the order was paid by a transfer T (`created` / `partially_reversed`), a `pending` `transfer_reversals` row for that amount (one per T and cause; a re-run finds it). A mirror larger than what is left of T (T was netted with other refunds) is recorded `failed` / `exceeds_transfer` and nets later.
- Execute (one transaction per reversal): lock the reversal, T, then the mirror entries; if the mirror no longer sums to the amount (a payout netted it first) → `failed` / `netted_in_payout` without calling Stripe. Otherwise `createTransferReversal` (`reversal:<reversalId>`, metadata `transfer_reversal_id` + cause id) **inside** the transaction (decided here): the locks keep a payout batch from netting the mirror at the same time, and a commit that fails after Stripe answered is retried with the same key. Success → `succeeded` + Stripe id, T's `amount_reversed_cents` and status, the mirror entries get `transfer_id = T` (T's entries then sum to amount − reversed, as `checkLedger` expects); refusal → `failed` + code, the mirror stays unpaid and is netted by the next payout (§19.10). `payout.reversed { cause, succeeded }` either way.

**Refunds** (`applyStripeRefund`, `requestRefund`)
- One function for every refund event and for the app's own refunds; lock order: order (found by charge id, PaymentIntent id or `metadata.order_ref`), then the refund (by `stripe_refund_id`, else `metadata.refund_id`, else a new row with `refund.created { source: "stripe" }`). Refunds of charges that are not ours are acknowledged and ignored.
- Status moves (`refundStatusMayMove`): older events never move a status backwards; a succeeded refund may still fail; a failed or canceled one never comes back. Unknown Stripe values map to `pending`.
- Succeeded (once): `amount_refunded_cents` + status (`disputed` stays `disputed`), `postRefundLedger` (waits for the sale with `order_not_posted`; `postOrderLedger` posts it later), full refund → every active access grant revoked, `order.refunded`; after the commit `payouts/reverse` (`reverse:refund:<id>`) and `refunds/succeeded` (`refund-succeeded:<id>`). A refund that would take more than the gross throws `LedgerError over_refund` (the event fails and stays visible).
- Succeeded → failed/canceled: refunded amount back down, `reverseRefundLedger` (the shares are payable again, also when a reversal had already pulled them back), **access restored** when this refund had ended it (decided here: the latest revoked grant is un-revoked; the buyer keeps the same link), `refund.failed`.
- `charge.refunded`: applies the refunds in the charge's `refunds.data` when Stripe includes it; Stripe no longer expands that list by default, so normally the `refund.*` events do the work and this one changes nothing.
- `requestRefund(db, { orderId, amountCents?, requestedByUserId, reason? }, { gateway })` (no UI yet: Phase 6's admin screen calls it after `canRefundOrder`; v1 buyer requests too): lock the order; refused (`RefundRequestError`: `not_found`, `not_refundable` incl. disputed orders, `too_much`, `no_payment`) when nothing is left after succeeded **and in-flight** refunds; inserts the `pending` row + `refund.created { source: "app" }` (actor = requester) and commits **before** calling Stripe (`refund:<refundId>`, metadata `refund_id`, `order_ref`); a `StripeGatewayError` → `failed` + `refund.failed`; otherwise Stripe's answer is applied at once (the webhook then changes nothing).
- `refunds-notify`: steps `load`, `buyer` (refund-confirmation.tsx, `sendEmail` with key `refund-confirmation:<refundId>`, required: a failure throws so the step retries), `member:<userId>` (`order.refunded`, required, dedupe `order.refunded:<refundId>:<userId>`). Nothing is sent if the refund is no longer `succeeded`. The buyer email has no link (buyers have no account) and says whether access ended.

**Chargebacks** (`applyStripeDispute`; every `charge.dispute.*` type, incl. `updated`, `funds_withdrawn`, `funds_reinstated`, which only refresh `stripe_status`)
- First sight of a dispute (any event): the `chargebacks` row (`open`, fee = the dispute's balance-transaction fees), order → `disputed` (the payout query leaves it out: the freeze), `order.disputed`; after the commit `notifyChargebackOpened`: members `order.disputed` (required email), active admins `admin.chargeback_opened` (dispute-opened.tsx). **Deviation:** these run in the webhook's `afterCommit`, not in a job (no job is registered for them and the job registry is frozen); a failure is reported per recipient, dedupe keys make any retry safe. A `chargebacks-notify` job would be the fix.
- Outcomes (`chargebackOutcome`): `won`, plus `warning_closed` and `prevented` (an inquiry that never became a chargeback) → won; `lost` → lost; everything else open.
- Won: `closed_at`, the order's status from its refunded amount again unless another chargeback on it is still open; the platform absorbs the dispute fee Stripe keeps (no ledger entry: the ledger books chargebacks only when lost, §19.31). Lost: `postChargebackLedger` (mirror + fee pair), refunded amount + status, access revoked when fully lost, then `payouts/reverse` (`reverse:chargeback:<id>`). `chargeback.closed { outcome }` either way.

**`transfer.reversed`** (`recordStripeTransferReversals`): reversals carrying our `metadata.transfer_reversal_id` (or a known Stripe id) are skipped; others (made in Stripe's dashboard) get a `succeeded` row without a cause, the transfer's `amount_reversed_cents` = Σ succeeded reversals, and a Sentry report: they have no ledger entries, so `ledger-check` flags the transfer until an admin books an adjustment (Phase 6).

**`ledger-check`** (`runLedgerCheck`): `checkLedger` with Stripe's transfers; each mismatch → `reportError(LedgerMismatchError)` with tags `area: ledger`, `kind` and extra = the ids only; returns counts per kind.

**Earnings pages** (`canViewOwnEarnings`; mobile-first, tabs "Overview / Payouts" with 44 px targets)
- `/app/earnings`: a payouts-not-ready note linking to Settings → Payouts; per currency Available / In the hold period / Paid out (`userBalances`) and the chargeback hold; "Coming out of the hold" (unpaid, not disputed entries by UTC release day, next 10); per launch (the user's sale shares, refunds and chargebacks, order count; a failed transfer's release lines are left out); the 20 newest sales of the user's launches with the user's own share ("Pending" while the fee is unknown); a count of "fee pending" sales. Never a buyer's email or the other member's share.
- `/app/earnings/payouts`: the user's transfers, newest first: date, status label, amount (struck through when failed), amount taken back for refunds, the failure reason in plain words with a link to the payout settings, and the Stripe reference.

**Tests:** unit `tests/unit/payouts/status.test.ts`; integration `tests/integration/payouts/payouts.test.ts` (hold, amounts, connected balances, entries marked, events, notices, emails, idempotent re-runs, minimum, not payouts-ready, chargeback freeze, netting, refused transfer released and paid later, a crashed run resumed without paying twice, `checkLedger` clean against Stripe, earnings data, the ledger-check job) and `refunds.test.ts` (partial refund before payout netted, full refund after payout reversed, refused reversal netted later, refusals, dashboard refund webhook idempotent and failed later with access restored, stale events, `charge.refunded` lists, foreign charges, chargebacks won and lost, `transfer.reversed` from the dashboard); e2e (written, not run in this wave) `tests/e2e/payouts-release.spec.ts` (§15 step 5 through `/api/test/jobs/payouts-release` with the clock mocked) and `tests/e2e/mobile-payouts.spec.ts`. Shared tests updated: `tests/unit/jobs.test.ts` (the payout run key is checked against the event schema instead of running the job, which now needs a database), `tests/unit/nav.test.ts` (Earnings follows `isBuiltRoute`), `tests/unit/stripe/handlers.test.ts` (the registry includes the money events).

**Open items**
- Free orders (gross 0) cannot be posted (§19.33); they never reach payouts.
- A refund or chargeback on an order whose sale was never posted is booked on the order (`amount_refunded_cents`) at once and in the ledger when the sale posts; no reversal is needed then because nothing was paid.
- Abandoned `pending` refunds (the app crashed between the insert and Stripe) stay `pending` and count as in flight; Phase 6's admin screen should offer to retry or cancel them.

### 19.36 W3 integration gate (Phases 4–5): findings and fixes
The integration gate for §19.32–§19.35. Decisions and fixes:

**E2E under `next dev` ran out of memory** (every later spec then failed with `ECONNREFUSED`)
- First trigger: a stale persistent Turbopack dev cache (`.next/dev`, 6.4 GB after many runs over many code versions). With it, compiling `/access/[token]` after the buyer-flow routes took the dev server from ~4.5 GB past the sandbox's 13.4 GB limit (reproduced with plain requests, even for a 404 token); with an empty cache the same sequence peaks at 2.9 GB. The cache is never pruned: **if `next dev` keeps growing or is OOM-killed, stop it and delete `.next/dev`** (README "Tests").
- Underlying limit: even from an empty cache, one `next dev` process keeps most of what it compiles. Measured per spec file alone: 2.7–8 GB (onboarding-profiles 8 GB, collabs 6.7 GB), the **same on the W2 commit** (7.6 GB for onboarding-profiles), so this is not a W3 regression; the suite (59 tests now, 51 at W2) just crossed the container's limit. Ruled out by measurement: the job registry in route graphs, the V8 heap (`--max-old-space-size` changed nothing), turning the persistent cache off (worse: OOM after 7 tests), mimalloc purge settings. Plain page compiles cost 0.1–0.6 GB each; the growth comes from the browser-driven flows.
- **Fix: `pnpm test:e2e` is `scripts/e2e.ts`.** Without `CI`, a whole-suite run is split into `E2E_DEV_SHARDS` (default 12) Playwright shards run one after another; before each, `.next/dev` is removed (unless another Next.js dev process is running), so every shard starts its own dev server from an empty cache, with its own global setup (re-seeded database). A shard of 17 tests from an empty cache peaked at 12.2 GB, and one started on the cache the previous shard left was OOM-killed within 5 tests, hence the shards and the cleared cache; with 8 shards of ~8 tests one server still peaked at 12.4 GB and one was OOM-killed late in its shard, so the default is 12. It exits non-zero if any shard failed. `CI=1` (build + start, which CI runs), `E2E_DEV_SHARDS=1`, spec files, `-g`/`--grep` or an explicit `--shard` give one plain run, as before. Other arguments pass through (`pnpm test:e2e --project=mobile` shards the mobile project).
- Under `next dev` the per-test timeout is 60 s (30 s with `CI`): a test that meets several cold routes (sign-up, onboarding, the redirect to `/app`) spent most of 30 s compiling (`payouts.spec.ts` "a builder sets up payouts during onboarding" timed out on a cold server).
- Also fixed on the way: `/access/[token]` and `/p/[slug]/success` imported small helpers (`assignLicenseKey`, `isFulfillable`) from `lib/orders/fulfil.ts`, which enqueues jobs, so those **pages** pulled the whole job registry into their graph. The helpers (plus `remainingLicenseKeys`) moved to `lib/orders/license-keys.ts` (re-exported by `fulfil.ts`). Keep page-side helpers out of modules that call `enqueue` or the webhook/refund/payout code.

**E2E global setup** (`tests/e2e/global-setup.ts`): `.data/` is now emptied **before** the database is re-created and seeded, not after. The seed writes fake state there (fake Stripe accounts, Checkout Sessions, charges and balance transactions of the seeded orders, the signed agreement's PDF, the outbox), which the old order deleted right after seeding.

**Seed** (`pnpm db:seed`, §15)
- Collabs: a fourth pair (`lib/seed/collabs.ts` pair 04: signed by both, `building`, tasks and messages, no launch), so with the launches step the seed has `agreement` (01), `ended` (02), `live` (03) and `building` (04). Discover specs use pairs 05–06.
- **Seeded payouts accounts are real fake-Stripe accounts:** `seedPayoutsAccount` (lib/seed/accounts.ts) creates the account through the fake gateway (`createConnectedAccount`, idempotency key `acct:<userId>`, the same id the app would get) and completes it like the fake onboarding page (`enabled`), so the payout job can transfer to seeded people (the fake refuses unknown accounts, §19.33). With live Stripe the seed keeps the placeholder `acct_seed_…` id and never calls Stripe. Countries outside the payout list fall back to DE.
- Orders: after the three purchases the seeded admin refunds €5 of `seed-buyer-02`'s order through `requestRefund` (refund row, fake Stripe refund, `applyStripeRefund` with its ledger mirror, the `payouts-reverse` and `refunds-notify` jobs). Idempotent per refunded order. `pnpm db:reset && pnpm db:seed` then `pnpm ledger:check`: "The ledger balances." (3 orders; ES order: gross 1200, VAT 208, fee 43, platform 95, shares 427 / 427; the refund mirrors tax −80, adjustment −18, platform −40, shares −181 / −181 = −500).
- `tests/integration/matching/seed.test.ts` points `dataDir` at a temporary directory (the people step now writes fake Stripe accounts); `tests/integration/collabs/seed.test.ts` covers four pairs.

**Free orders** (open item of §19.33 / §19.34 / §19.35, decided here): an order with gross 0 (a 100 % discount: no PaymentIntent, no balance transaction) has nothing to post. `checkLedger` no longer reports it as `order_not_posted` (it still requires 0 entries) and `postPendingOrders` skips it, instead of retrying it every hour. Test in `tests/integration/ledger/balances-check.test.ts`.

**Spec fixes:** `tests/e2e/payouts-release.spec.ts` clicked an ambiguous "Overview" link (the sidebar has an Overview sub-item too); it now clicks the one in the Earnings tabs. `tests/e2e/mobile.spec.ts` threw when no builder menu page was left unbuilt; since Phases 4–5 every builder page exists, so its "Coming soon" block runs only while a planned page is in the builder's menu (the "Page not found" checks still run).

**Acceptance walk (2026-10-06, `FAKE_SERVICES=all`, production build on port 3100, fresh `pnpm db:reset && pnpm db:seed`)**
- Setup through the app's own functions: collab 04 (building) got a `license_key` launch (3 keys) and a new pair-07 collab (signed by both) a `file` launch (a PDF uploaded and promoted), each approved by both members and the seeded admin; the seeded `url` launch was already live.
- Phase 4, phone viewport (390 px, light and dark): `/r/<code>` → product page (`?ref=` appended, no sideways scroll) → Buy → fake Checkout (DE) → success page → access: `url` answered 307 to the delivery URL, `license_key` showed `WALK-KEY-0001`, `file` downloaded through `/access/<token>/files/<id>` (302 to a signed fake-storage URL that served the PDF). Every order `paid`, attributed to the creator's default link, ledger posted. Headless Chromium's user agent counts as a bot (no `attr` cookie, `?ref=` attributed, `is_bot` logged); with a Safari iPhone UA the cookie was set and the order recorded `attribution = cookie`. No console errors.
- Phase 5 ledger, checked by hand: e.g. the €29 key order (DE): VAT 463 (19 % included), fee 69 (1.5 % + €0.25, half up), platform 237 (10 % of net 2368, half up), members 959 / 1172 at 45/55 (largest remainder); the €9.99 file order: 160 / 40 / 80 / 503 / 216 at 70/30. Every order's entries sum to gross; `available_at` = paid + 14 days.
- Payouts (`POST /api/test/jobs/payouts-release` with a mocked clock): 4 days in, nothing; after the hold, 4 fake transfers totalling 7,351 cents, each equal to the user's available balance (pair 07's 503 and 216 cents stayed under the €10 minimum); a second run the same day answered `already_completed`.
- Refunds after the payout (`requestRefund`, as Phase 6's admin screen will call it): the full refund of a key order zeroed every component, revoked access ("This purchase is no longer available") and reversed both members' shares out of their transfers (`partially_reversed`); a €3 partial refund of the €12 order mirrored tax −48, platform −24, fee adjustment −11, shares −109 / −108, reversals succeeded; a €3 partial refund of the not-yet-paid file order left its mirrors unpaid to net later. `pnpm ledger:check` (with the fake Stripe comparison) and the `ledger-check` job: 7 orders, 4 transfers, no mismatch.
- Events: no email address or access token in any event property or context; earnings, payouts, launches and home pages of members show no buyer email.

**Cross-cutting checks**
- Money is integer cents in every ledger, payout, refund, checkout and launch module (the only rounding is the take rate to basis points and the fake's VAT/fee arithmetic, both integer).
- Buyer emails: stored on `orders` only; read by the receipt, refund confirmation and the seed; never in events (PII guard), never on member-visible pages (earnings, launches, sale notices show amounts and shares only).
- Webhooks are idempotent by event id (`stripe_events`) and by object (order per session, refund per Stripe id, chargeback per dispute id); replays are covered by the integration tests.
- Rate limits: `/r/<code>` (`redirect`, per IP), `POST /p/<slug>/checkout` (`checkout`, per IP), the view beacon and `/access` (`access`, per IP).
- README: Phases 4–5, the seeded launch, orders and refund, the fake Stripe row, a payout run with a mocked clock.

**Gate results (2026-10-06):** GitHub CI on the pushed head (`196379d`, PR #1): green (both jobs, both workflow runs). Locally: typecheck, lint, format, unit + integration (137 files, 1,500 tests), build, e2e under `CI=1` (build + start, one run: 59/59, server peak 0.6 GB) and under `next dev` through `pnpm test:e2e` (12 shards: 59/59, server peak 11.8 GB). Scratch database left for inspection: `creator_gate_w3` (local Postgres; the seeded data plus the walk's launches, orders, payouts and refunds).

### 19.37 W3 (Phases 4–5): review findings
Fixes for the W3 review. Each has a test that fails without it.

**Launches: an edit while paused is reviewed again** (§12, §16 Phase 4; supersedes §19.31's "in `paused`, approvals only re-arm resume" and §19.32's resume rule for edited launches)
- `launchStatusAfter("paused", "save", { autoApprove })`: without `AUTO_APPROVE_LAUNCHES`, any content edit of a paused launch (setup fields, files, images; license keys are stock and change nothing) sends it back to `draft` (`paused_at` / `paused_by` cleared), so the new version needs both approvals **and** an admin's (`admin_review` → `live` through the normal go-live, which is not a "first time": no second default link or `launch.live` notice). With `AUTO_APPROVE_LAUNCHES` it stays `paused` and both approvals re-arm "Resume", as before (the members' approvals are the gate there). A pause without an edit keeps the plain resume.
- A launch that went live once stays public in every status (`isPublicLaunch` / `publicLaunchStatus` in status.ts): back in review it shows "Not available right now" on `/p/<slug>`, and its tracked links and images keep working. Open item: that page shows the edited, not yet reviewed text (as paused launches already did).
- **Past buyers keep what they bought** (decided here; the review's "forbid" option, no schema change): once a launch has any order, the delivery type and a URL delivery's target cannot change, and deliverable files cannot be removed (adding files and editing license-key instructions still work). The plain-language refusals name support for real changes (Phase 6 admin tools).

**Chargebacks**
- A chargeback lost after a refund (Stripe lets a buyer dispute the whole charge) no longer throws `over_refund`: `computeChargebackMirror` mirrors what is left of the order and books the excess as a platform `adjustment` (user null), so the chargeback's lines still sum to −amount; `amount_refunded_cents` is capped at gross; the order leaves `disputed`, access ends. `componentsFromEntries` caps the Stripe-fee component at its sale amount (the excess only exists once every component is fully reversed).
- **Dispute fees are booked when Stripe withdraws them, whatever the outcome** (§9 "every component"): `postDisputeFeeLedger` keeps a `stripe_fee +delta` / `adjustment −delta` pair (chargeback id set) in step with `chargebacks.fee_cents` on every dispute event, idempotent on what is already booked, waiting for the sale like refunds (`postOrderLedger` books it later). `fee_cents` is the net fee of the dispute's balance transactions; while open it only grows, a closed snapshot settles it (a won dispute whose fee Stripe returned brings it to 0 and books the reversed pair), after closing it only comes down, so stale events never re-book it. `postChargebackLedger` no longer adds the fee. Fake: `closeFakeDispute(…, "won", { returnFee: true })`.
- `ledger:check`'s order invariant is now Σ entries = gross − succeeded refunds − lost chargebacks (an order can go below zero: the platform's loss), plus `order_refunded`: `amount_refunded_cents` = min(gross, that sum).

**Refund and dispute events before their order** (`lib/orders/unrecorded-payment.ts`)
- When no order matches, `applyStripeRefund` / `applyStripeDispute` ask Stripe whether the payment is ours (`isOurCheckoutPayment`: the PaymentIntent, found directly or through the charge, carries our checkout metadata naming a launch in this database). If so they throw `OrderNotRecordedYetError`: the event fails (500) and Stripe retries it until fulfilment has created the order. Payments of other integrations or environments are acknowledged as before. Fulfilment itself does not look at the charge's refunds; `ledger:check` now catches a refund that slipped through anyway (below).

**`ledger:check` false negatives** (§9 "transfer totals match Stripe", both directions)
- New mismatch kinds: `transfer_unknown` (a transfer at Stripe in the last 35 days with no row of ours; new gateway method `listTransfers({ createdFrom })`, live and fake), several transfers in one `payout_<id>` group (`transfer_stripe`), `transfer_pending` / `reversal_pending` (still pending after a day), `order_stripe` (for orders paid in the last 120 days: Stripe's `charge.amount_refunded` ≠ our succeeded refunds, a disputed charge (`disputed`, added to the charge schema) without a chargeback row, or the charge missing at Stripe; one Stripe read per order per run), `order_refunded`. `LedgerCheckGateway` = `listTransfersByGroup`, `listTransfers`, `retrieveCharge`.
- Not done (decided): recomputing each sale's member split; the take rate may have changed since the sale, and the split is unit- and property-tested.

**Refund between a batch's collect and pay** (`lib/payouts/reverse.ts`)
- `planReversals` also plans against a `pending` transfer T (collected, not paid yet). `executeReversal` defers while T is pending (`deferred`), and fails with `transfer_failed` (the mirror nets later) when T was refused. The batch runs `runDeferredReversals` in a new `reversals:<transferId>` step after each pay step, so the refund is clawed back from T as soon as it is paid.

**Privacy**
- **PostHog** `before_send` (`lib/analytics/posthog-client.ts`) and **Sentry** `beforeSend` / new `beforeSendTransaction` (`scrubEvent`) run `redactDeep` (`lib/analytics/redact.ts`, client-safe) over every string: `/access/<token>` → `/access/[token]` (also in autocapture's `href`s and referrers) and the values of `session_id`, `token`, `email`, `code`, `state`, `sig`, `signature` → `[redacted]`. `withoutQuery` (the request path for `onRequestError`) redacts the token segment too.
- **`stripe_events.payload`** is stored without personal data (`redactStripePayload`, `lib/stripe/redact-payload.ts`): `customer_details`, `customer_email`, `billing_details`, `receipt_email`, `shipping*`, `collected_information`, `email`, `phone`, and `account.*`'s `individual`, `company`, `business_profile`, `external_accounts` become null at any depth. Handlers still read the event as received. This also closes §19.12's open item for new events; rows stored before this change keep their payload (Phase 6's GDPR deletion must still redact them).

**Success page and view beacon**
- `/p/<slug>/success` asks Stripe only when no order exists for the session, and at most 30 times per minute per IP (bucket `checkout-success`, `SUCCESS_STRIPE_LOOKUPS`); over the limit it shows "finishing" without calling Stripe.
- The view beacon forwards the page's `?ref=` (`viewBeaconUrl`), and `recordProductPageView` resolves the link with `resolveCheckoutAttribution` (cookie first, then `ref`; enabled links of this launch only), so views, checkouts and orders are attributed by the same rule.

**Tests:** unit `tests/unit/ledger/refund.test.ts` (capped mirror, excess, fee pairs, property with disputes beyond what is left), `tests/unit/analytics-redact.test.ts`, `tests/unit/stripe/redact-payload.test.ts`, `tests/unit/launches/attribution.test.ts` (beacon URL), status machine in `tests/unit/launches/fields.test.ts` / `tests/unit/w3/contracts.test.ts`; integration `tests/integration/launches/launches.test.ts` (paused edit → review → admin; auto-approve resume; delivery and files fixed once sold), `tests/integration/launches/attribution.test.ts` (view via `?ref=`), `tests/integration/payouts/refunds.test.ts` (lost chargeback after a partial refund, fee booked on a won dispute and returned, refund/dispute events retried until the order exists, refund between collect and pay reversed), `tests/integration/ledger/balances-check.test.ts` (new mismatch kinds), `tests/integration/ledger/post.test.ts`, `tests/integration/checkout/checkout.test.ts` (success-page Stripe reads limited).

**Results (2026-10-06):** typecheck, lint, format, unit + integration (139 files, 1,519 tests), build, e2e under `CI=1` (build + start: 59/59) and under `next dev` through `pnpm test:e2e` (12 shards: 59/59). `pnpm db:reset && pnpm db:seed && pnpm ledger:check` on a scratch database with an empty `.data/`: "The ledger balances." Note for whoever runs the sharded e2e: `scripts/e2e.ts` keeps `.next/dev` when any process's arguments match `next-server|next dev`, including a shell command that merely mentions those words (e.g. a `pgrep` in the same command line); the shards then reuse one growing cache and `next dev` is OOM-killed.
