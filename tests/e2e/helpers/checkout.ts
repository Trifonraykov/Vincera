import { randomBytes } from "node:crypto"

import type { Page } from "@playwright/test"

import { newId } from "@/lib/ids"

import { withE2eDb } from "./db"

/**
 * Checkout in the browser (CLAUDE.md §19.34): a live launch with the creator's default tracked
 * link, set up in the database (the launch pages have their own specs), and reads of the order the
 * purchase wrote. Buyers have no account, so no sign-in is needed.
 */

export type LiveLaunchFixture = {
  launchId: string
  slug: string
  title: string
  linkId: string
  linkCode: string
  creatorUserId: string
  builderUserId: string
}

/** A live €19 license-key launch (two keys in stock), 60/40, with a default tracked link. */
export async function insertLiveKeyLaunch(title = "Focus timer Pro"): Promise<LiveLaunchFixture> {
  const tag = randomBytes(4).toString("hex")
  const ids = {
    creator: newId(),
    builder: newId(),
    idea: newId(),
    proposal: newId(),
    revision: newId(),
    collab: newId(),
    launch: newId(),
    link: newId(),
  }
  const slug = `focus-timer-${tag}`
  const linkCode = `Ck${tag}`.slice(0, 8)
  await withE2eDb(async (pool) => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      for (const [id, role, name] of [
        [ids.creator, "creator", "Cleo Creates"],
        [ids.builder, "builder", "Bram Builds"],
      ] as const) {
        const handle = `${role}_${tag}`
        await client.query(
          `INSERT INTO users (id, email, name, roles, active_role, onboarding_completed_at)
           VALUES ($1, $2, $3, ARRAY[$4]::text[], $4::user_role, now())`,
          [id, `e2e-${role}-${tag}@example.com`, name, role],
        )
        await client.query("INSERT INTO handles (handle, user_id) VALUES ($1, $2)", [handle, id])
        await client.query(
          `INSERT INTO ${role}_profiles (id, user_id, handle, display_name) VALUES ($1, $2, $3, $4)`,
          [newId(), id, handle, name],
        )
      }
      await client.query(
        `INSERT INTO ideas (id, creator_profile_id, title, problem, format, status, published_at)
         SELECT $1, cp.id, $2, 'People want to focus.', 'app', 'launched', now()
         FROM creator_profiles cp WHERE cp.user_id = $3`,
        [ids.idea, title, ids.creator],
      )
      await client.query(
        `INSERT INTO proposals (id, from_user_id, to_user_id, idea_id, status, closed_at, responded_at)
         VALUES ($1, $2, $3, $4, 'accepted', now(), now())`,
        [ids.proposal, ids.builder, ids.creator, ids.idea],
      )
      await client.query(
        `INSERT INTO proposal_revisions (id, proposal_id, author_user_id, revision_number, scope,
           creator_split_pct, builder_split_pct, timeline_weeks)
         VALUES ($1, $2, $3, 1, 'A small app.', 60, 40, 4)`,
        [ids.revision, ids.proposal, ids.builder],
      )
      await client.query("UPDATE proposals SET current_revision_id = $1 WHERE id = $2", [
        ids.revision,
        ids.proposal,
      ])
      await client.query(
        "INSERT INTO collabs (id, proposal_id, idea_id, stage) VALUES ($1, $2, $3, 'live')",
        [ids.collab, ids.proposal, ids.idea],
      )
      await client.query(
        `INSERT INTO collab_members (id, collab_id, user_id, role, split_pct)
         VALUES ($1, $3, $4, 'creator', 60), ($2, $3, $5, 'builder', 40)`,
        [newId(), newId(), ids.collab, ids.creator, ids.builder],
      )
      await client.query(
        `INSERT INTO launches (id, collab_id, slug, title, tagline, description_md, price_cents,
           delivery_type, delivery_config, status, submitted_at, went_live_at)
         VALUES ($1, $2, $3, $4, 'Deep work in 25-minute blocks', 'A **focus timer** for makers.',
           1900, 'license_key', '{"type":"license_key","instructions":"Paste the key in Settings → License."}',
           'live', now(), now())`,
        [ids.launch, ids.collab, slug, title],
      )
      await client.query(
        `INSERT INTO license_keys (id, launch_id, key) VALUES ($1, $3, $4), ($2, $3, $5)`,
        [newId(), newId(), ids.launch, `FOCUS-${tag}-0001`, `FOCUS-${tag}-0002`],
      )
      await client.query(
        `INSERT INTO tracked_links (id, launch_id, owner_user_id, code, label, is_default)
         VALUES ($1, $2, $3, $4, 'Default', true)`,
        [ids.link, ids.launch, ids.creator, linkCode],
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  })
  return {
    launchId: ids.launch,
    slug,
    title,
    linkId: ids.link,
    linkCode,
    creatorUserId: ids.creator,
    builderUserId: ids.builder,
  }
}

export type OrderState = {
  id: string
  buyer_email: string
  status: string
  amount_gross_cents: number
  tax_cents: number
  stripe_fee_cents: number
  tracked_link_id: string | null
  attribution: string | null
  ledger_posted: boolean
  ledger_sum: number
  license_key: string | null
}

export async function orderOf(launchId: string, buyerEmail: string): Promise<OrderState | null> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<OrderState>(
      `SELECT o.id, o.buyer_email, o.status, o.amount_gross_cents, o.tax_cents, o.stripe_fee_cents,
              o.tracked_link_id, o.attribution::text AS attribution,
              o.ledger_posted_at IS NOT NULL AS ledger_posted,
              coalesce((SELECT sum(amount_cents) FROM ledger_entries WHERE order_id = o.id), 0)::int AS ledger_sum,
              (SELECT key FROM license_keys WHERE order_id = o.id) AS license_key
       FROM orders o WHERE o.launch_id = $1 AND o.buyer_email = $2`,
      [launchId, buyerEmail],
    )
    return rows[0] ?? null
  })
}

export function buyerEmail(): string {
  return `e2e-buyer-${randomBytes(4).toString("hex")}@example.com`
}

/** On the fake Stripe Checkout page: fill in the buyer and pay by test card. */
export async function payOnFakeCheckout(page: Page, email: string, country = "DE"): Promise<void> {
  await page.waitForURL(/\/api\/dev\/fake-stripe\/checkout\/cs_fake_/)
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Country").selectOption(country)
  await page.getByRole("button", { name: "Pay with test card 4242" }).click()
}

/** How far the page scrolls sideways (0 when it fits). */
export async function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement
    return root.scrollWidth - window.innerWidth
  })
}
