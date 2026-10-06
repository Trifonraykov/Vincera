import { ScrollText } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { formatUtc, Pager } from "@/components/admin/admin-ui"
import { NativeSelect } from "@/components/profiles/form-kit"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_TARGET_TYPES,
  adminAuditActionLabel,
} from "@/lib/admin/audit"
import { auditAdmins, cursorOf, listAuditLog, parseCursor } from "@/lib/admin/queries"
import { canManageUsers } from "@/lib/auth/authz"
import { authorizePage, requireAdmin } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"

export const metadata: Metadata = { title: "Audit log" }

type Params = {
  admin?: string
  action?: string
  targetType?: string
  targetId?: string
  before?: string
}
type Props = { searchParams: Promise<Params> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Where a target's admin page is, when it has one. */
function targetHref(type: string, id: string | null): string | null {
  if (!id) return null
  if (type === "user") return `/admin/users/${id}`
  if (type === "collab") return `/admin/collabs/${id}`
  if (type === "dispute") return `/admin/disputes/${id}`
  return null
}

/** Snapshot JSON as text (React escapes it); short, one line per key. */
function Snapshot({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <pre className="overflow-x-auto rounded bg-muted p-2 text-xs break-all whitespace-pre-wrap">
        {JSON.stringify(value, null, 1)}
      </pre>
    </div>
  )
}

/**
 * The admin audit log (§14 "every admin action is written to admin_audit_log"; a page beyond §12,
 * CLAUDE.md §19.38): newest first, filtered by admin, action and target; snapshots shown as text.
 */
export default async function AdminAuditPage({ searchParams }: Props) {
  const user = await requireAdmin()
  authorizePage(canManageUsers(user), "/app")
  const params = await searchParams
  const filter = {
    adminUserId: params.admin && UUID.test(params.admin) ? params.admin : undefined,
    action: params.action && params.action in ADMIN_AUDIT_ACTIONS ? params.action : undefined,
    targetType: ADMIN_AUDIT_TARGET_TYPES.includes(
      params.targetType as (typeof ADMIN_AUDIT_TARGET_TYPES)[number],
    )
      ? params.targetType
      : undefined,
    targetId: params.targetId && UUID.test(params.targetId) ? params.targetId : undefined,
  }
  const before = parseCursor(params.before)
  const db = getDb()
  const [{ items, hasMore }, admins] = await Promise.all([
    listAuditLog(db, { ...filter, before }),
    auditAdmins(db),
  ])
  const query = (extra: Record<string, string | undefined>) => {
    const search = new URLSearchParams()
    const all = {
      admin: filter.adminUserId,
      action: filter.action,
      targetType: filter.targetType,
      targetId: filter.targetId,
      ...extra,
    }
    for (const [key, value] of Object.entries(all)) if (value) search.set(key, value)
    const text = search.toString()
    return text ? `/admin/audit?${text}` : "/admin/audit"
  }
  const last = items.at(-1)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Every admin action, with what changed. Rows are never edited or deleted."
      />
      <form action="/admin/audit" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="audit-admin">Admin</Label>
          <NativeSelect
            id="audit-admin"
            name="admin"
            defaultValue={filter.adminUserId ?? ""}
            className="h-11 sm:h-9"
          >
            <option value="">Any admin</option>
            {admins.map((admin) => (
              <option key={admin.id} value={admin.id}>
                {admin.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-action">Action</Label>
          <NativeSelect
            id="audit-action"
            name="action"
            defaultValue={filter.action ?? ""}
            className="h-11 sm:h-9"
          >
            <option value="">Any action</option>
            {Object.entries(ADMIN_AUDIT_ACTIONS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-target-type">Target</Label>
          <NativeSelect
            id="audit-target-type"
            name="targetType"
            defaultValue={filter.targetType ?? ""}
            className="h-11 sm:h-9"
          >
            <option value="">Any target</option>
            {ADMIN_AUDIT_TARGET_TYPES.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-target-id">Target id</Label>
          <Input
            id="audit-target-id"
            name="targetId"
            defaultValue={filter.targetId ?? ""}
            placeholder="uuid"
            className="h-11 sm:h-9"
          />
        </div>
        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
          <Button type="submit" className="h-11 sm:h-9">
            Filter
          </Button>
          <Button asChild variant="ghost" className="h-11 sm:h-9">
            <Link href="/admin/audit">Clear</Link>
          </Button>
        </div>
      </form>

      {items.length === 0 ? (
        <EmptyState icon={ScrollText} title="No audit entries match" />
      ) : (
        <ol className="space-y-3" aria-label="Audit entries">
          {items.map((row) => {
            const target = targetHref(row.targetType, row.targetId)
            return (
              <li key={row.id} className="space-y-2 rounded-xl border bg-card p-4 text-sm">
                <p className="font-medium">{adminAuditActionLabel(row.action)}</p>
                <p className="text-muted-foreground">
                  {formatUtc(row.createdAt)} · by{" "}
                  <Link className="underline" href={`/admin/users/${row.adminUserId}`}>
                    {row.adminName}
                  </Link>{" "}
                  · {row.targetType.replaceAll("_", " ")}{" "}
                  {row.targetId ? (
                    target ? (
                      <Link className="underline" href={target}>
                        {row.targetId}
                      </Link>
                    ) : (
                      <code className="text-xs break-all">{row.targetId}</code>
                    )
                  ) : null}
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Snapshot label="Before" value={row.before} />
                  <Snapshot label="After" value={row.after} />
                </div>
              </li>
            )
          })}
        </ol>
      )}
      <Pager
        newestHref={before ? query({}) : undefined}
        olderHref={hasMore && last ? query({ before: cursorOf(last) }) : undefined}
      />
    </div>
  )
}
