"use client"

import { ExternalLink, FolderGit2, Loader2, Trash2 } from "lucide-react"
import { useActionState, useState } from "react"

import { EmptyState } from "@/components/shared/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import type { ActionResult } from "@/lib/actions/result"
import { deletePortfolioItemAction } from "@/lib/profiles/actions"
import {
  PORTFOLIO_MAX_ITEMS,
  PRODUCT_FORMAT_LABELS,
  type ProfileFormSource,
} from "@/lib/profiles/fields"

import { PortfolioItemDialog, type PortfolioItemView } from "./portfolio-item-dialog"

/** The builder's portfolio: the list with edit and delete, and "Add a project". */
export function PortfolioManager({
  items,
  source,
  headingLevel = "h2",
}: {
  items: readonly PortfolioItemView[]
  source: ProfileFormSource
  /** Level of each project's title. */
  headingLevel?: "h2" | "h3" | "h4"
}) {
  const Heading = headingLevel
  const full = items.length >= PORTFOLIO_MAX_ITEMS

  if (items.length === 0) {
    return (
      <EmptyState
        icon={FolderGit2}
        title="No projects yet"
        description="Add a few things you've built. Shipped work helps creators trust you with theirs."
        action={<PortfolioItemDialog source={source} />}
      />
    )
  }

  return (
    <div className="space-y-4">
      <ul className="grid gap-3" aria-label="Your projects">
        {items.map((item) => (
          <li key={item.id} className="rounded-xl border bg-card p-4 shadow-xs">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              {item.imageSrc ? (
                // Redirects to a short-lived signed URL (lib/profiles/portfolio-image.ts), which
                // next/image would need every storage host configured for.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.imageSrc}
                  alt=""
                  loading="lazy"
                  className="aspect-[4/3] w-full shrink-0 rounded-lg border bg-muted object-cover sm:w-28"
                />
              ) : null}
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Heading className="font-medium break-words">{item.title}</Heading>
                  {item.isShipped ? <Badge variant="secondary">Shipped</Badge> : null}
                  {item.format ? (
                    <Badge variant="outline">{PRODUCT_FORMAT_LABELS[item.format]}</Badge>
                  ) : null}
                </div>
                {item.description ? (
                  <p className="text-sm break-words text-muted-foreground">{item.description}</p>
                ) : null}
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex max-w-full items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    <span className="truncate">{displayUrl(item.url)}</span>
                    <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <PortfolioItemDialog source={source} item={item} />
                <DeletePortfolioItemButton source={source} item={item} />
              </div>
            </div>
          </li>
        ))}
      </ul>
      {full ? (
        <p className="text-sm text-muted-foreground">
          You&apos;re showing {PORTFOLIO_MAX_ITEMS} projects, the most a profile can hold. Remove
          one to add another.
        </p>
      ) : (
        <PortfolioItemDialog source={source} />
      )}
    </div>
  )
}

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`
  } catch {
    return url
  }
}

function DeletePortfolioItemButton({
  source,
  item,
}: {
  source: ProfileFormSource
  item: PortfolioItemView
}) {
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<{ itemId: string }> | null, formData: FormData) => {
      const result = await deletePortfolioItemAction(formData)
      if (result.ok) setOpen(false)
      return result
    },
    null,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
          <Trash2 aria-hidden="true" />
          Remove<span className="sr-only"> {item.title}</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove “{item.title}”?</DialogTitle>
          <DialogDescription>
            It disappears from your profile. You can add it again later.
          </DialogDescription>
        </DialogHeader>
        {state && !state.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        <form action={formAction}>
          <input type="hidden" name="itemId" value={item.id} />
          <input type="hidden" name="from" value={source} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Keep it
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Remove project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
