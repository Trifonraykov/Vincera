import { randomBytes } from "node:crypto"

import { Pool } from "pg"

import { newId } from "@/lib/ids"
import type { OnboardingStepsRecord } from "@/lib/onboarding/steps"

/**
 * Direct access to the e2e database (E2E_DATABASE_URL, exported by playwright.config.ts) for
 * setting up state a test is not about. Prefer driving the UI; use this only for preconditions.
 */
export async function withE2eDb<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error("E2E_DATABASE_URL is not set (see playwright.config.ts).")
  const pool = new Pool({ connectionString, max: 1 })
  try {
    return await fn(pool)
  } finally {
    await pool.end()
  }
}

/**
 * Finish onboarding for the user with `email` without the onboarding pages: a handle and a
 * profile for each of their app roles, the optional steps recorded as skipped (the review as
 * done), and `onboarding_completed_at`. For specs whose subject is not onboarding itself; the
 * Phase 1 onboarding spec walks the real pages.
 */
export async function completeOnboardingInDb(email: string): Promise<void> {
  await withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ id: string; roles: string[]; name: string | null }>(
      "SELECT id, roles, name FROM users WHERE email = $1",
      [email.toLowerCase()],
    )
    const user = rows[0]
    if (!user) throw new Error(`completeOnboardingInDb: no user with email ${email}`)
    const isCreator = user.roles.includes("creator")
    const isBuilder = user.roles.includes("builder")
    if (!isCreator && !isBuilder) throw new Error("completeOnboardingInDb: choose a role first")

    const existing = await pool.query<{ handle: string }>(
      "SELECT handle FROM handles WHERE user_id = $1 LIMIT 1",
      [user.id],
    )
    let handle = existing.rows[0]?.handle
    if (!handle) {
      handle = `e2e_${randomBytes(5).toString("hex")}`
      await pool.query("INSERT INTO handles (handle, user_id) VALUES ($1, $2)", [handle, user.id])
    }
    const displayName = user.name ?? handle

    const at = new Date().toISOString()
    const steps: OnboardingStepsRecord = { payouts: { status: "skipped", at } }
    if (isCreator) {
      await pool.query(
        `INSERT INTO creator_profiles (id, user_id, handle, display_name)
         VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO NOTHING`,
        [newId(), user.id, handle, displayName],
      )
      steps["creator.connect"] = { status: "skipped", at }
      steps["creator.review"] = { status: "done", at }
    }
    if (isBuilder) {
      await pool.query(
        `INSERT INTO builder_profiles (id, user_id, handle, display_name)
         VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO NOTHING`,
        [newId(), user.id, handle, displayName],
      )
      steps["builder.portfolio"] = { status: "skipped", at }
    }

    await pool.query(
      `UPDATE users
       SET onboarding_steps = $2::jsonb || onboarding_steps,
           onboarding_completed_at = COALESCE(onboarding_completed_at, now())
       WHERE id = $1`,
      [user.id, JSON.stringify(steps)],
    )
  })
}

/** The fake YouTube fixture "Ada Codes" (tests/fixtures/social/youtube/ada-codes.json). */
export const ADA_CODES_CHANNEL_ID = "UCaDaC0des5x7Qm1RkT9pLzw"

/**
 * Free a fake provider account (a fixture such as YouTube's "Ada Codes") that an earlier test in
 * the same run connected: one platform user per provider account (§19.11), so a second test
 * connecting the same fixture would get `?error=account_in_use`. Deletes that connection the way
 * a disconnect does (snapshots cascade through the GDPR erasure hatch, §19.5). Tests run
 * serially, so this never pulls a connection from under a running test.
 */
export async function releaseSocialAccount(
  provider: "youtube" | "instagram" | "tiktok" | "github",
  providerAccountId: string,
): Promise<void> {
  await withE2eDb(async (pool) => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.gdpr_erasure', 'on', true)")
      await client.query(
        "DELETE FROM social_connections WHERE provider = $1 AND provider_account_id = $2",
        [provider, providerAccountId],
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  })
}
