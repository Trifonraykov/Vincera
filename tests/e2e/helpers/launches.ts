import { randomBytes } from "node:crypto"

import type { Browser, BrowserContextOptions, Page } from "@playwright/test"

import { newId } from "@/lib/ids"

import { E2E_ADMIN_EMAIL } from "./accounts"
import { signIn } from "./auth"
import { withE2eDb } from "./db"

/**
 * Launches in the browser (CLAUDE.md §19.32): a signed collab in `building` set up in the
 * database (the agreement pages have their own specs), the admin in their own browser context,
 * and reads of what the pages wrote.
 */

/** An idea of the creator, a builder's accepted proposal and a collab in `building`. */
export async function insertBuildingCollab(
  creatorUserId: string,
  builderUserId: string,
  title: string,
): Promise<string> {
  return withE2eDb(async (pool) => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const [ideaId, proposalId, revisionId, collabId, threadId] = [
        newId(),
        newId(),
        newId(),
        newId(),
        newId(),
      ]
      const idea = await client.query(
        `INSERT INTO ideas (id, creator_profile_id, title, problem, format, status, published_at)
         SELECT $1, cp.id, $2, 'People want a simple way to plan this.', 'app', 'in_collab', now()
         FROM creator_profiles cp WHERE cp.user_id = $3`,
        [ideaId, title, creatorUserId],
      )
      if (idea.rowCount !== 1) throw new Error("insertBuildingCollab: no creator profile")
      await client.query(
        `INSERT INTO proposals (id, from_user_id, to_user_id, idea_id, status, closed_at, responded_at)
         VALUES ($1, $2, $3, $4, 'accepted', now(), now())`,
        [proposalId, builderUserId, creatorUserId, ideaId],
      )
      await client.query(
        `INSERT INTO proposal_revisions (id, proposal_id, author_user_id, revision_number, scope,
           creator_split_pct, builder_split_pct, timeline_weeks)
         VALUES ($1, $2, $3, 1, 'A small web app.', 60, 40, 6)`,
        [revisionId, proposalId, builderUserId],
      )
      await client.query("UPDATE proposals SET current_revision_id = $1 WHERE id = $2", [
        revisionId,
        proposalId,
      ])
      await client.query(
        "INSERT INTO collabs (id, proposal_id, idea_id, stage) VALUES ($1, $2, $3, 'building')",
        [collabId, proposalId, ideaId],
      )
      await client.query(
        `INSERT INTO collab_members (id, collab_id, user_id, role, split_pct)
         VALUES ($1, $3, $4, 'creator', 60), ($2, $3, $5, 'builder', 40)`,
        [newId(), newId(), collabId, creatorUserId, builderUserId],
      )
      await client.query("INSERT INTO threads (id, kind, collab_id) VALUES ($1, 'collab', $2)", [
        threadId,
        collabId,
      ])
      await client.query(
        `INSERT INTO thread_reads (id, thread_id, user_id) VALUES ($1, $3, $4), ($2, $3, $5)`,
        [newId(), newId(), threadId, creatorUserId, builderUserId],
      )
      await client.query("COMMIT")
      return collabId
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  })
}

/** The admin (ADMIN_EMAILS in playwright.config.ts) signed in, in a context of their own. */
export async function signedInAdmin(
  browser: Browser,
  baseURL: string,
  contextOptions: BrowserContextOptions = {},
): Promise<Page> {
  const [a, b] = [randomBytes(2).toString("hex"), randomBytes(2).toString("hex")]
  const context = await browser.newContext({
    ...contextOptions,
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": `2001:db8::${a}:${b}` },
  })
  const page = await context.newPage()
  await signIn(page, E2E_ADMIN_EMAIL)
  return page
}

export type LaunchState = {
  id: string
  status: string
  slug: string
  stage: string
  link_code: string | null
  link_id: string | null
}

export async function launchState(collabId: string): Promise<LaunchState | null> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<LaunchState>(
      `SELECT l.id, l.status, l.slug, c.stage, t.code AS link_code, t.id AS link_id
       FROM launches l JOIN collabs c ON c.id = l.collab_id
       LEFT JOIN tracked_links t ON t.launch_id = l.id AND t.is_default
       WHERE l.collab_id = $1`,
      [collabId],
    )
    return rows[0] ?? null
  })
}

export async function clickCount(linkId: string): Promise<number> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM link_clicks WHERE tracked_link_id = $1 AND NOT is_bot",
      [linkId],
    )
    return rows[0]?.n ?? 0
  })
}

export async function launchEventTypes(launchId: string): Promise<string[]> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ type: string }>(
      "SELECT type FROM events WHERE subject_id = $1 ORDER BY occurred_at, id",
      [launchId],
    )
    return rows.map((row) => row.type)
  })
}
