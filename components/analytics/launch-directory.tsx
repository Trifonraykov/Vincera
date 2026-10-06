"use client"

import { Rocket, Search } from "lucide-react"
import Link from "next/link"
import { useId, useMemo, useState } from "react"

import { EmptyState } from "@/components/shared/empty-state"
import { Input } from "@/components/ui/input"
import type { DirectoryLaunch } from "@/lib/analytics/directory"
import type { ProductFormat } from "@/lib/db/schema/enums"
import { formatMoney } from "@/lib/money"
import { PRODUCT_FORMAT_LABELS } from "@/lib/profiles/fields"
import { cn } from "@/lib/utils"

type Sort = "newest" | "price_low" | "price_high"

/** Lowercase, accents removed: "Café" matches "cafe". */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
}

/**
 * Filters the live launches in the browser (the page is static): search by title and tagline,
 * a format chip row, a topic picker and the order. Cards link to the product pages.
 */
export function LaunchDirectory({ items }: { items: readonly DirectoryLaunch[] }) {
  const [query, setQuery] = useState("")
  const [format, setFormat] = useState<ProductFormat | "all">("all")
  const [topic, setTopic] = useState("")
  const [sort, setSort] = useState<Sort>("newest")
  const searchId = useId()
  const topicId = useId()
  const sortId = useId()

  const formats = useMemo(
    () =>
      (Object.keys(PRODUCT_FORMAT_LABELS) as ProductFormat[]).filter((f) =>
        items.some((item) => item.format === f),
      ),
    [items],
  )
  const topics = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) for (const t of item.topics) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t]) => t)
  }, [items])

  const visible = useMemo(() => {
    const needle = fold(query.trim())
    const filtered = items.filter(
      (item) =>
        (format === "all" || item.format === format) &&
        (topic === "" || item.topics.includes(topic)) &&
        (needle === "" || fold(`${item.title} ${item.tagline ?? ""}`).includes(needle)),
    )
    if (sort === "newest") return filtered
    return [...filtered].sort((a, b) =>
      sort === "price_low" ? a.priceCents - b.priceCents : b.priceCents - a.priceCents,
    )
  }, [items, query, format, topic, sort])

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Rocket}
        title="No launches on sale right now"
        description="New products appear here the moment they go live. Check back soon."
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_12rem_12rem]">
        <div className="relative">
          <label htmlFor={searchId} className="sr-only">
            Search launches
          </label>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name"
            className="h-11 pl-9"
          />
        </div>
        <div>
          <label htmlFor={topicId} className="sr-only">
            Topic
          </label>
          <select
            id={topicId}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm dark:bg-input/30"
          >
            <option value="">All topics</option>
            {topics.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={sortId} className="sr-only">
            Order
          </label>
          <select
            id={sortId}
            value={sort}
            onChange={(event) => setSort(event.target.value as Sort)}
            className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm dark:bg-input/30"
          >
            <option value="newest">Newest first</option>
            <option value="price_low">Price: low to high</option>
            <option value="price_high">Price: high to low</option>
          </select>
        </div>
      </div>
      {formats.length > 1 ? (
        <div
          role="group"
          aria-label="Format"
          className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0"
        >
          <div className="flex min-w-max gap-2">
            {(["all", ...formats] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={format === f}
                onClick={() => setFormat(f)}
                className={cn(
                  "inline-flex h-11 items-center rounded-full border px-4 text-sm font-medium transition-colors md:h-8",
                  format === f
                    ? "border-primary bg-primary text-primary-foreground"
                    : "hover:bg-accent",
                )}
              >
                {f === "all" ? "All formats" : PRODUCT_FORMAT_LABELS[f]}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {visible.length === items.length
          ? `${items.length} ${items.length === 1 ? "launch" : "launches"}`
          : `${visible.length} of ${items.length} launches`}
      </p>
      {visible.length === 0 ? (
        <EmptyState
          icon={Search}
          title="Nothing matches"
          description="Try another word, or clear the filters."
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((item) => (
            <li key={item.slug}>
              <LaunchCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LaunchCard({ item }: { item: DirectoryLaunch }) {
  const makers = [item.creator, item.builder].filter((p) => p !== null)
  return (
    <Link
      href={`/p/${item.slug}`}
      className="flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {item.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a redirect to a signed URL (§19.32)
        <img
          src={item.imageUrl}
          alt={item.imageAlt ?? ""}
          loading="lazy"
          className="aspect-[16/9] w-full object-cover"
        />
      ) : (
        <div
          className="flex aspect-[16/9] w-full items-center justify-center bg-muted"
          aria-hidden="true"
        >
          <Rocket className="size-8 text-muted-foreground" />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-semibold break-words">{item.title}</h2>
          <span className="shrink-0 font-medium tabular-nums">
            {formatMoney(item.priceCents, item.currency)}
          </span>
        </div>
        {item.tagline ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{item.tagline}</p>
        ) : null}
        {makers.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            by {makers.map((p) => `@${p.handle}`).join(" × ")}
          </p>
        ) : null}
        <p className="mt-auto flex flex-wrap gap-1.5 pt-1 text-xs">
          {item.format ? (
            <span className="rounded-full bg-muted px-2 py-0.5">
              {PRODUCT_FORMAT_LABELS[item.format]}
            </span>
          ) : null}
          {item.topics.slice(0, 3).map((t) => (
            <span key={t} className="rounded-full border px-2 py-0.5 text-muted-foreground">
              {t}
            </span>
          ))}
        </p>
      </div>
    </Link>
  )
}
