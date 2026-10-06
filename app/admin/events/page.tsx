import { Activity } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { DailyColumns } from "@/components/analytics/daily-columns"
import { RangePicker } from "@/components/analytics/range-picker"
import { NativeSelect } from "@/components/profiles/form-kit"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  countEventsByTypePerDay,
  EVENTS_MAX_DAYS,
  formatEventCursor,
  listEvents,
  parseEventCursor,
  parseEventFilters,
  type EventFilters,
} from "@/lib/analytics/events-explorer"
import { canViewEvents } from "@/lib/auth/authz"
import { authorizePage, requireAdmin } from "@/lib/auth/session"
import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import { EVENT_TYPES, SUBJECT_TYPES } from "@/lib/events/types"

export const metadata: Metadata = { title: "Events" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/** The filters as search params (for links that keep them: presets, paging). */
function filterParams(filters: EventFilters): Record<string, string> {
  const params: Record<string, string> = {}
  if (filters.type) params.type = filters.type
  if (filters.subjectType) params.subject_type = filters.subjectType
  if (filters.subjectId) params.subject_id = filters.subjectId
  if (filters.actorId) params.actor_id = filters.actorId
  return params
}

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
})

/**
 * The event log explorer (§12 `/admin/events`, v1; CLAUDE.md §19.38). Filters: type, subject type
 * and id, actor id, a UTC day range (≤ 90 days); 50 events per page, newest first, with the
 * properties and context as JSON text (React escapes it); counts by type per day for the same
 * filters. Admins only (`canViewEvents`). Events carry no personal data by construction (§11).
 */
export default async function AdminEventsPage({ searchParams }: Props) {
  const user = await requireAdmin()
  authorizePage(canViewEvents(user), "/app")
  const query = await searchParams
  const at = now()
  const filters = parseEventFilters(query, at)
  const cursor = parseEventCursor(query.before)
  const db = getDb()
  const [page, counts] = await Promise.all([
    listEvents(db, filters, cursor),
    countEventsByTypePerDay(db, filters),
  ])
  const extra = filterParams(filters)
  const rangeParams = { from: filters.range.from, to: filters.range.to }
  const totalInRange = counts.totals.reduce((sum, value) => sum + value, 0)
  const typeHref = (type: string) =>
    `/admin/events?${new URLSearchParams({ ...extra, ...rangeParams, type }).toString()}`

  return (
    <div className="space-y-6">
      <PageHeader
        title="Events"
        description="The business event log: what happened, to what, and when. Ids, counts and amounts only, never personal data."
      />

      <form
        method="get"
        action="/admin/events"
        className="grid grid-cols-1 gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <input type="hidden" name="from" value={filters.range.from} />
        <input type="hidden" name="to" value={filters.range.to} />
        <label className="grid gap-1 text-sm">
          Type
          <NativeSelect name="type" defaultValue={filters.type ?? ""} className="h-11 md:h-9">
            <option value="">Any type</option>
            {EVENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-sm">
          Subject type
          <NativeSelect
            name="subject_type"
            defaultValue={filters.subjectType ?? ""}
            className="h-11 md:h-9"
          >
            <option value="">Any subject</option>
            {SUBJECT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-sm">
          Subject id
          <Input
            name="subject_id"
            defaultValue={filters.subjectId ?? ""}
            placeholder="UUID"
            autoComplete="off"
            className="h-11 font-mono md:h-9"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Actor id
          <Input
            name="actor_id"
            defaultValue={filters.actorId ?? ""}
            placeholder="UUID"
            autoComplete="off"
            className="h-11 font-mono md:h-9"
          />
        </label>
        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
          <Button type="submit" className="h-11 md:h-9">
            Filter
          </Button>
          <Button asChild variant="outline" className="h-11 md:h-9">
            <Link href="/admin/events">Clear</Link>
          </Button>
        </div>
      </form>

      <RangePicker
        basePath="/admin/events"
        range={filters.range}
        now={at}
        maxDays={EVENTS_MAX_DAYS}
        presets={[1, 7, 30, 90]}
        extra={extra}
      />

      <section aria-labelledby="counts-heading" className="space-y-3">
        <h2 id="counts-heading" className="font-semibold">
          Counts
        </h2>
        <DailyColumns title="Events per day" days={counts.days} values={counts.totals} />
        {counts.types.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[480px] text-left text-sm">
              <caption className="sr-only">Events by type in the range</caption>
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="px-4 py-2 font-normal">
                    Type
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-normal">
                    Events
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-normal">
                    Share
                  </th>
                  <th scope="col" className="px-4 py-2 font-normal">
                    Per day
                  </th>
                </tr>
              </thead>
              <tbody>
                {counts.types.map((row) => {
                  const peak = Math.max(1, ...row.daily)
                  return (
                    <tr key={row.type} className="border-b last:border-b-0">
                      <th scope="row" className="px-4 py-2 font-normal">
                        <Link
                          href={typeHref(row.type)}
                          className="font-mono underline-offset-4 hover:underline"
                        >
                          {row.type}
                        </Link>
                      </th>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {row.total.toLocaleString("en-US")}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {totalInRange > 0
                          ? `${Math.round((row.total / totalInRange) * 100)}%`
                          : "–"}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex h-6 w-40 items-end gap-px" aria-hidden="true">
                          {row.daily.map((value, index) => (
                            <div
                              key={counts.days[index]}
                              title={`${counts.days[index]}: ${value}`}
                              className="min-w-0 flex-1 rounded-t-[1px] bg-[#2a78d6] dark:bg-[#3987e5]"
                              style={{
                                height: value > 0 ? `${Math.max((value / peak) * 100, 8)}%` : "0",
                              }}
                            />
                          ))}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="list-heading" className="space-y-3">
        <h2 id="list-heading" className="font-semibold">
          {cursor ? "Older events" : "Newest events"}
        </h2>
        {page.events.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No events match"
            description="Try a longer range or fewer filters."
          />
        ) : (
          <ol className="space-y-2" aria-label="Events">
            {page.events.map((event) => (
              <li key={event.id} className="rounded-xl border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-mono font-medium break-all">{event.type}</span>
                  <time dateTime={event.occurredAt.toISOString()} className="text-muted-foreground">
                    {timeFormat.format(event.occurredAt)} UTC
                  </time>
                </div>
                <dl className="mt-1 grid grid-cols-1 gap-x-4 text-xs text-muted-foreground sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="inline">Subject: </dt>
                    <dd className="inline font-mono break-all">
                      {event.subjectType ? `${event.subjectType} ${event.subjectId}` : "none"}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="inline">Actor: </dt>
                    <dd className="inline font-mono break-all">{event.actorUserId ?? "none"}</dd>
                  </div>
                </dl>
                <details className="mt-1">
                  <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs text-muted-foreground md:min-h-0">
                    Properties and context
                  </summary>
                  <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs break-all whitespace-pre-wrap">
                    {JSON.stringify(
                      { properties: event.properties, context: event.context },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
        )}
        <div className="flex flex-wrap gap-2">
          {cursor ? (
            <Button asChild variant="outline" className="h-11 md:h-9">
              <Link
                href={`/admin/events?${new URLSearchParams({ ...extra, ...rangeParams }).toString()}`}
              >
                Newest
              </Link>
            </Button>
          ) : null}
          {page.next ? (
            <Button asChild variant="outline" className="h-11 md:h-9">
              <Link
                href={`/admin/events?${new URLSearchParams({
                  ...extra,
                  ...rangeParams,
                  before: formatEventCursor(page.next),
                }).toString()}`}
              >
                Older
              </Link>
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  )
}
