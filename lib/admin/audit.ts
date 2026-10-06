import "server-only"

import type { DbOrTx } from "@/lib/db/client"
import { adminAuditLog, type AuditSnapshot } from "@/lib/db/schema"
import { findPii, scrubPii } from "@/lib/events/pii"

/**
 * The admin audit helper (§6, §14; CLAUDE.md §19.38): every admin action writes one
 * `admin_audit_log` row with the target's changed fields before and after, **in the same
 * transaction as the change** (pass the action's `tx`). Written by the W4 prep and shared by
 * every Phase 6–7 area; the list of actions below is the registry (frozen for builders: a new
 * action is a contract change).
 *
 * Snapshots hold ids, statuses, amounts and short admin-written notes. Never emails, tokens or
 * message bodies: like `track()` (lib/events/pii.ts), a key or value that looks like one throws
 * outside production and is scrubbed in production.
 *
 * Phase 1 and 4 code that already writes the table directly keeps its actions
 * (`user.role_granted`, `social_connection.verified`, `launch.*`); they are listed here too, so the
 * audit log page can label every action.
 */

export const ADMIN_AUDIT_ACTIONS = {
  // Users (admin area)
  "user.role_granted": "Granted the admin role",
  "user.role_revoked": "Revoked the admin role",
  "user.suspended": "Suspended an account",
  "user.unsuspended": "Lifted a suspension",
  "impersonation.started": "Started viewing as a user",
  "impersonation.stopped": "Stopped viewing as a user",
  "social_connection.verified": "Verified a manual social entry",
  // Collabs and launches
  "collab.ended": "Ended a collab",
  "launch.approved": "Approved a launch",
  "launch.rejected": "Sent a launch back",
  "launch.paused": "Paused a launch",
  "launch.resumed": "Resumed a launch",
  "launch.ended": "Ended a launch",
  // Disputes and money
  "dispute.in_review": "Took a dispute into review",
  "dispute.resolved": "Resolved a dispute",
  "ledger.adjusted": "Made a ledger adjustment",
  "refund.requested": "Refunded an order",
  "refund.canceled": "Cancelled a stuck refund",
  "payouts.run_started": "Started a payout run",
  "refund_request.approved": "Approved a refund request",
  "refund_request.declined": "Declined a refund request",
  // Matching (Phase 7)
  "matching.model_trained": "Trained a matching model",
  "matching.model_activated": "Activated a matching model",
  "matching.model_deactivated": "Deactivated a matching model",
} as const

export type AdminAuditAction = keyof typeof ADMIN_AUDIT_ACTIONS

/** What `admin_audit_log.target_type` names (the table of `target_id`, singular). */
export const ADMIN_AUDIT_TARGET_TYPES = [
  "user",
  "social_connection",
  "impersonation_session",
  "collab",
  "launch",
  "dispute",
  "ledger_adjustment",
  "order",
  "refund",
  "refund_request",
  "payout_batch",
  "matching_config",
] as const

export type AdminAuditTargetType = (typeof ADMIN_AUDIT_TARGET_TYPES)[number]

export type AdminAuditEntry = {
  /** The real admin (never an impersonation target). */
  adminUserId: string
  action: AdminAuditAction
  targetType: AdminAuditTargetType
  targetId: string | null
  /** The target's changed fields before the action (null for a creation). */
  before: AuditSnapshot | null
  /** The same fields after it, plus context such as a note or an amount. */
  after: AuditSnapshot | null
}

export class AuditSnapshotPiiError extends Error {
  constructor(action: string, paths: readonly string[]) {
    super(`Audit "${action}" has snapshot fields that look like personal data: ${paths.join(", ")}`)
    this.name = "AuditSnapshotPiiError"
  }
}

function isProductionRuntime(): boolean {
  const appEnv = process.env.APP_ENV?.trim()
  return appEnv ? appEnv === "production" : process.env.NODE_ENV === "production"
}

function cleanSnapshot(action: string, snapshot: AuditSnapshot | null): AuditSnapshot | null {
  if (snapshot === null) return null
  const findings = findPii(snapshot)
  if (findings.length === 0) return snapshot
  const paths = findings.map((finding) => finding.path)
  if (!isProductionRuntime()) throw new AuditSnapshotPiiError(action, paths)
  console.error(new AuditSnapshotPiiError(action, paths).message)
  return scrubPii(snapshot) as AuditSnapshot
}

/** Write one audit row; returns its id. Call it inside the action's transaction. */
export async function writeAdminAudit(tx: DbOrTx, entry: AdminAuditEntry): Promise<string> {
  const [row] = await tx
    .insert(adminAuditLog)
    .values({
      adminUserId: entry.adminUserId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: cleanSnapshot(entry.action, entry.before),
      after: cleanSnapshot(entry.action, entry.after),
    })
    .returning({ id: adminAuditLog.id })
  if (!row) throw new Error("writeAdminAudit: no row returned")
  return row.id
}

/** The label of a stored action, for the audit log page (unknown actions show as they are). */
export function adminAuditActionLabel(action: string): string {
  return (ADMIN_AUDIT_ACTIONS as Record<string, string>)[action] ?? action
}
