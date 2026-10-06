import "server-only"

import { sql, type SQL } from "drizzle-orm"

/**
 * What happened after each shown match (CLAUDE.md §19.38 "Rows and labels"), as one SQL
 * fragment shared by the training dataset and the score-bucket funnel.
 *
 * A proposal is **linked** to a shown match row (`shown_at` set) of a model version when it was
 * sent at or after the row's `created_at` and either names the match (`proposals.match_id`), or
 * is between the subject and the target's owner (either direction) about the match's idea or
 * product, or (creator/builder targets) between the subject and the target user. Per row:
 *
 * - `sent`: a linked proposal exists;
 * - `accepted`: a linked proposal reached `accepted`;
 * - `live`: an accepted linked proposal's collab has a launch that went live;
 * - `sale`: an accepted linked proposal's collab has a launch with ≥ 1 order not `refunded`;
 * - `first_created_at` / `first_snapshot`: the earliest linked proposal's send time and its
 *   `match_snapshot` (the pre-outcome features).
 *
 * Each match row appears once (aggregated), so nothing downstream counts a row twice.
 */
export function matchOutcomesCte(modelVersion: string): SQL {
  return sql`
    shown AS (
      SELECT
        m.id,
        m.subject_user_id,
        m.target_type,
        m.target_id,
        m.score,
        m.features,
        m.computed_at,
        m.created_at,
        CASE m.target_type
          WHEN 'idea' THEN (
            SELECT cp.user_id FROM ideas i
            JOIN creator_profiles cp ON cp.id = i.creator_profile_id
            WHERE i.id = m.target_id
          )
          WHEN 'product' THEN (
            SELECT bp.user_id FROM products pr
            JOIN builder_profiles bp ON bp.id = pr.builder_profile_id
            WHERE pr.id = m.target_id
          )
          ELSE m.target_id
        END AS owner_id
      FROM matches m
      WHERE m.model_version = ${modelVersion} AND m.shown_at IS NOT NULL
    ),
    links AS (
      SELECT s.id AS match_id, p.id AS proposal_id
      FROM shown s
      JOIN proposals p ON p.match_id = s.id
      WHERE p.created_at >= s.created_at
      UNION
      SELECT s.id, p.id
      FROM shown s
      JOIN proposals p ON p.idea_id = s.target_id
      WHERE s.target_type = 'idea'
        AND p.created_at >= s.created_at
        AND (
          (p.from_user_id = s.subject_user_id AND p.to_user_id = s.owner_id)
          OR (p.from_user_id = s.owner_id AND p.to_user_id = s.subject_user_id)
        )
      UNION
      SELECT s.id, p.id
      FROM shown s
      JOIN proposals p ON p.product_id = s.target_id
      WHERE s.target_type = 'product'
        AND p.created_at >= s.created_at
        AND (
          (p.from_user_id = s.subject_user_id AND p.to_user_id = s.owner_id)
          OR (p.from_user_id = s.owner_id AND p.to_user_id = s.subject_user_id)
        )
      UNION
      SELECT s.id, p.id
      FROM shown s
      JOIN proposals p
        ON (p.from_user_id = s.subject_user_id AND p.to_user_id = s.target_id)
        OR (p.from_user_id = s.target_id AND p.to_user_id = s.subject_user_id)
      WHERE s.target_type IN ('creator', 'builder')
        AND p.created_at >= s.created_at
    ),
    proposal_outcomes AS (
      SELECT
        l.match_id,
        p.id AS proposal_id,
        p.created_at,
        p.match_snapshot,
        p.status = 'accepted' AS accepted,
        p.status = 'accepted' AND EXISTS (
          SELECT 1 FROM collabs c
          JOIN launches la ON la.collab_id = c.id
          WHERE c.proposal_id = p.id AND la.went_live_at IS NOT NULL
        ) AS live,
        p.status = 'accepted' AND EXISTS (
          SELECT 1 FROM collabs c
          JOIN launches la ON la.collab_id = c.id
          JOIN orders o ON o.launch_id = la.id
          WHERE c.proposal_id = p.id AND o.status <> 'refunded'
        ) AS sale
      FROM links l
      JOIN proposals p ON p.id = l.proposal_id
    ),
    outcomes AS (
      SELECT
        s.id,
        s.score,
        s.features,
        s.computed_at,
        count(po.proposal_id) > 0 AS sent,
        coalesce(bool_or(po.accepted), false) AS accepted,
        coalesce(bool_or(po.live), false) AS live,
        coalesce(bool_or(po.sale), false) AS sale,
        min(po.created_at) AS first_created_at,
        (array_agg(po.match_snapshot ORDER BY po.created_at, po.proposal_id)
          FILTER (WHERE po.proposal_id IS NOT NULL))[1] AS first_snapshot
      FROM shown s
      LEFT JOIN proposal_outcomes po ON po.match_id = s.id
      GROUP BY s.id, s.score, s.features, s.computed_at
    )
  `
}
