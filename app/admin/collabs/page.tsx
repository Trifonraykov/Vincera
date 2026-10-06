import { Handshake, Search } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { FilterChips, formatUtc, StatusPill } from "@/components/admin/admin-ui"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { STAGE_TEXT } from "@/lib/admin/fields"
import { listCollabsForAdmin } from "@/lib/admin/queries"
import { canManageUsers } from "@/lib/auth/authz"
import { authorizePage, requireAdmin } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import type { CollabStage } from "@/lib/db/schema/enums"

export const metadata: Metadata = { title: "Collabs" }

type Props = { searchParams: Promise<{ stage?: string; q?: string }> }

const STAGES = Object.keys(STAGE_TEXT) as CollabStage[]

/** /admin/collabs (§12, Phase 6): every collab, most recently active first, by stage. */
export default async function AdminCollabsPage({ searchParams }: Props) {
  const user = await requireAdmin()
  authorizePage(canManageUsers(user), "/app")
  const params = await searchParams
  const stage = STAGES.includes(params.stage as CollabStage)
    ? (params.stage as CollabStage)
    : undefined
  const q = typeof params.q === "string" ? params.q.slice(0, 100) : ""
  const items = await listCollabsForAdmin(getDb(), { stage, q })
  const link = (next?: CollabStage) => {
    const search = new URLSearchParams()
    if (next) search.set("stage", next)
    if (q) search.set("q", q)
    const query = search.toString()
    return query ? `/admin/collabs?${query}` : "/admin/collabs"
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Collabs" description="Who works with whom, and how far they are." />
      <form role="search" action="/admin/collabs" className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="collab-search" className="sr-only">
          Search collabs by title
        </label>
        <Input
          id="collab-search"
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Idea or product title"
          className="h-11 sm:h-9"
        />
        {stage ? <input type="hidden" name="stage" value={stage} /> : null}
        <Button type="submit" className="h-11 sm:h-9">
          <Search aria-hidden="true" />
          Search
        </Button>
      </form>
      <FilterChips
        label="Stages"
        chips={[
          { href: link(), label: "All stages", active: !stage },
          ...STAGES.map((entry) => ({
            href: link(entry),
            label: STAGE_TEXT[entry],
            active: stage === entry,
          })),
        ]}
      />
      {items.length === 0 ? (
        <EmptyState icon={Handshake} title="No collabs here" />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Collabs">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/admin/collabs/${item.id}`}
                className="flex min-h-11 flex-col gap-1 p-4 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0">
                  <span className="block font-medium break-words">{item.title}</span>
                  <span className="block text-sm text-muted-foreground">
                    {item.members.map((member) => `${member.name} (${member.role})`).join(" × ")}
                    {" · "}active {formatUtc(item.lastActivityAt)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-wrap gap-1">
                  <StatusPill>{STAGE_TEXT[item.stage]}</StatusPill>
                  {item.openDisputes > 0 ? (
                    <StatusPill tone="bad">
                      {item.openDisputes} {item.openDisputes === 1 ? "dispute" : "disputes"}
                    </StatusPill>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
