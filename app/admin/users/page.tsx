import { Search, Users } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { FilterChips, Pager, StatusPill } from "@/components/admin/admin-ui"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cursorOf, parseCursor } from "@/lib/admin/queries"
import { searchUsers, type UserRoleFilter } from "@/lib/admin/users"
import { canManageUsers } from "@/lib/auth/authz"
import { authorizePage, requireAdmin } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import type { UserStatus } from "@/lib/db/schema/enums"

export const metadata: Metadata = { title: "Users" }

type Props = {
  searchParams: Promise<{ q?: string; role?: string; status?: string; before?: string }>
}

const ROLES: { id: UserRoleFilter | "all"; label: string }[] = [
  { id: "all", label: "Everyone" },
  { id: "creator", label: "Creators" },
  { id: "builder", label: "Builders" },
  { id: "admin", label: "Admins" },
]
const STATUSES: (UserStatus | "deleted")[] = ["active", "suspended", "deleted"]

function href(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value)
  const query = search.toString()
  return query ? `/admin/users?${query}` : "/admin/users"
}

/** /admin/users (§12, Phase 6): search by email, name, handle or id; filter by role and status. */
export default async function AdminUsersPage({ searchParams }: Props) {
  const user = await requireAdmin()
  authorizePage(canManageUsers(user), "/app")
  const params = await searchParams
  const q = typeof params.q === "string" ? params.q.slice(0, 100) : ""
  const role = ROLES.some((r) => r.id === params.role && r.id !== "all")
    ? (params.role as UserRoleFilter)
    : undefined
  const status = STATUSES.includes(params.status as UserStatus)
    ? (params.status as UserStatus | "deleted")
    : undefined
  const before = parseCursor(params.before)
  const { items, hasMore } = await searchUsers(getDb(), { q, role, status, before })
  const base = { q: q || undefined, role, status }
  const last = items.at(-1)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Find an account to check its connections, payouts and collabs, or to act on it."
      />
      <form role="search" action="/admin/users" className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="user-search" className="sr-only">
          Search users
        </label>
        <Input
          id="user-search"
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Email, name, @handle or id"
          className="h-11 sm:h-9"
        />
        {role ? <input type="hidden" name="role" value={role} /> : null}
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <Button type="submit" className="h-11 sm:h-9">
          <Search aria-hidden="true" />
          Search
        </Button>
      </form>
      <FilterChips
        label="Roles"
        chips={ROLES.map((entry) => ({
          href: href({ ...base, role: entry.id === "all" ? undefined : entry.id }),
          label: entry.label,
          active: (role ?? "all") === entry.id,
        }))}
      />
      <FilterChips
        label="Status"
        chips={[
          { href: href({ ...base, status: undefined }), label: "Any status", active: !status },
          ...STATUSES.map((entry) => ({
            href: href({ ...base, status: entry }),
            label: entry[0]?.toUpperCase() + entry.slice(1),
            active: status === entry,
          })),
        ]}
      />

      {items.length === 0 ? (
        <EmptyState icon={Users} title="No accounts match" description="Try another search." />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Accounts">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/admin/users/${item.id}`}
                className="flex min-h-11 flex-col gap-1 p-4 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0">
                  <span className="block font-medium break-words">
                    {item.name ?? (item.deletedAt ? "Deleted user" : "No name")}
                  </span>
                  <span className="block text-sm break-all text-muted-foreground">
                    {item.email ?? "—"}
                    {item.creatorHandle ? ` · @${item.creatorHandle}` : ""}
                    {item.builderHandle && item.builderHandle !== item.creatorHandle
                      ? ` · @${item.builderHandle}`
                      : ""}
                  </span>
                </span>
                <span className="flex shrink-0 flex-wrap gap-1">
                  {item.roles.map((r) => (
                    <StatusPill key={r} tone={r === "admin" ? "bad" : "neutral"}>
                      {r}
                    </StatusPill>
                  ))}
                  {item.deletedAt ? (
                    <StatusPill tone="warn">deleted</StatusPill>
                  ) : item.status === "suspended" ? (
                    <StatusPill tone="bad">suspended</StatusPill>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Pager
        newestHref={before ? href(base) : undefined}
        olderHref={hasMore && last ? href({ ...base, before: cursorOf(last) }) : undefined}
      />
    </div>
  )
}
