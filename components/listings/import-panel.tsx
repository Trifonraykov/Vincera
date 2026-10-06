"use client"

import {
  AppWindow,
  BadgeCheck,
  Check,
  Copy,
  Globe,
  Loader2,
  RefreshCw,
  ShieldQuestion,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useId, useState, useTransition, type FormEvent } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ActionResult } from "@/lib/actions/result"
import { parseAppStoreInput } from "@/lib/listings/app-store/link"
import {
  checkAppStoreVerificationAction,
  connectAppStoreAction,
  disconnectAppStoreAction,
  importWebListingAction,
  refreshAppStoreAction,
} from "@/lib/listings/actions"
import { cn } from "@/lib/utils"

/**
 * "Import from the App Store" and "Import from a link" (CLAUDE.md §19.45), for the builder's
 * Products page and the onboarding portfolio step. Paste a developer link (or an app link, or the
 * id) and every app becomes a published listing; paste a product's web address and its page
 * becomes one. Verification: put the shown code in any app's description, then "Check".
 */

export type ImportPanelProps = {
  appStore: {
    developerName: string | null
    developerUrl: string
    verified: boolean
    verificationCode: string | null
    syncedAt: string | null
    syncError: string | null
  } | null
  listings: {
    id: string
    title: string
    source: "app_store" | "web"
    removed: boolean
    iconUrl: string | null
    coverUrl: string | null
    gradient: string
    initials: string
  }[]
  /** Where listing tiles link (the product page). */
  compact?: boolean
}

type Summary = {
  developerName: string
  apps: number
  created: number
  updated: number
  removed: number
}

function summaryText(summary: Summary): string {
  const parts = [
    summary.created > 0 ? `${summary.created} new` : null,
    summary.updated > 0 ? `${summary.updated} updated` : null,
    summary.removed > 0 ? `${summary.removed} no longer in the store` : null,
  ].filter(Boolean)
  return parts.length > 0
    ? `${summary.developerName}: ${parts.join(", ")}.`
    : `${summary.developerName}: everything is up to date.`
}

function relativeDate(iso: string | null): string | null {
  if (!iso) return null
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

function useAction() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [fieldError, setFieldError] = useState<string | null>(null)
  function run<T>(
    action: () => Promise<ActionResult<T>>,
    onSuccess: (data: T) => void,
    field?: string,
  ) {
    setFieldError(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        const message = (field && result.fieldErrors?.[field]?.[0]) ?? result.error
        if (field && result.fieldErrors?.[field]) setFieldError(message)
        else toast.error(message)
        return
      }
      onSuccess(result.data)
      router.refresh()
    })
  }
  return { pending, fieldError, run }
}

function AppStoreCard({ appStore }: { appStore: ImportPanelProps["appStore"] }) {
  const id = useId()
  const [value, setValue] = useState("")
  const [hint, setHint] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const connect = useAction()
  const refresh = useAction()
  const verify = useAction()
  const disconnect = useAction()

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!parseAppStoreInput(value)) {
      setHint("Paste a link from apps.apple.com, like apps.apple.com/us/developer/…/id123456789.")
      return
    }
    setHint(null)
    connect.run(
      () => connectAppStoreAction({ appStore: value }),
      (summary) => {
        setValue("")
        toast.success(summaryText(summary))
      },
      "appStore",
    )
  }

  const error = hint ?? connect.fieldError
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-4 rounded-3xl border bg-card p-5"
      data-testid="app-store-import"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white">
          <AppWindow aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <h2 id={`${id}-title`} className="font-semibold">
            Import from the App Store
          </h2>
          <p className="text-sm text-muted-foreground">
            {appStore
              ? "Your apps are listed for creators. New apps show up on their own every day."
              : "Paste your developer link and every app you've published becomes a listing creators can find."}
          </p>
        </div>
      </div>

      {appStore ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={appStore.developerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline-offset-4 hover:underline"
            >
              {appStore.developerName ?? "Your developer account"}
            </a>
            {appStore.verified ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-700 dark:text-sky-300">
                <BadgeCheck aria-hidden="true" className="size-3.5" />
                Verified
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                <ShieldQuestion aria-hidden="true" className="size-3.5" />
                Unverified
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {appStore.syncError
                ? "Last refresh failed. Try again later."
                : appStore.syncedAt
                  ? `Updated ${relativeDate(appStore.syncedAt)}`
                  : null}
            </span>
          </div>

          {!appStore.verified && appStore.verificationCode ? (
            <div className="space-y-3 rounded-2xl bg-muted/60 p-4 text-sm">
              <p>
                Prove it&apos;s yours: add this code anywhere in one app&apos;s description on App
                Store Connect, then check. You can remove it once you&apos;re verified.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded-lg bg-background px-3 py-2 font-mono text-base tracking-wider">
                  {appStore.verificationCode}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11"
                  onClick={() => {
                    void navigator.clipboard?.writeText(appStore.verificationCode ?? "")
                    setCopied(true)
                  }}
                >
                  {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={verify.pending}
                  onClick={() =>
                    verify.run(
                      () => checkAppStoreVerificationAction({}),
                      () => toast.success("Verified. Creators now see your apps as yours."),
                    )
                  }
                >
                  {verify.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                  Check now
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={refresh.pending}
              onClick={() =>
                refresh.run(
                  () => refreshAppStoreAction({}),
                  (summary) => toast.success(summaryText(summary)),
                )
              }
            >
              <RefreshCw className={cn(refresh.pending && "animate-spin")} aria-hidden="true" />
              Refresh
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-11 text-muted-foreground"
              disabled={disconnect.pending}
              onClick={() =>
                disconnect.run(
                  () => disconnectAppStoreAction({}),
                  () => toast.success("Disconnected. Your listings stay until you archive them."),
                )
              }
            >
              Use another account
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-2">
          <Label htmlFor={`${id}-input`}>Developer link or id</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`${id}-input`}
              name="appStore"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="apps.apple.com/us/developer/…/id123456789"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="h-11"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : `${id}-hint`}
            />
            <Button type="submit" className="h-11 shrink-0" disabled={connect.pending}>
              {connect.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {connect.pending ? "Importing" : "Import my apps"}
            </Button>
          </div>
          {error ? (
            <p id={`${id}-error`} className="text-sm text-destructive">
              {error}
            </p>
          ) : (
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">
              An app link works too: we&apos;ll find its developer.
            </p>
          )}
        </form>
      )}
    </section>
  )
}

function WebImportCard() {
  const id = useId()
  const [value, setValue] = useState("")
  const action = useAction()

  function submit(event: FormEvent) {
    event.preventDefault()
    action.run(
      () => importWebListingAction({ url: value }),
      (result) => {
        setValue("")
        toast.success(
          result.action === "created"
            ? `Listed “${result.title}”.`
            : result.action === "updated"
              ? `Updated “${result.title}”.`
              : `“${result.title}” is already up to date.`,
        )
      },
      "url",
    )
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-4 rounded-3xl border bg-card p-5"
      data-testid="web-import"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white">
          <Globe aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <h2 id={`${id}-title`} className="font-semibold">
            Import from a link
          </h2>
          <p className="text-sm text-muted-foreground">
            A web app, template or tool? Paste its page and we&apos;ll make the listing from it.
          </p>
        </div>
      </div>
      <form onSubmit={submit} noValidate className="space-y-2">
        <Label htmlFor={`${id}-input`}>Product page</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={`${id}-input`}
            name="url"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="https://yourproduct.com"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            className="h-11"
            aria-invalid={action.fieldError ? true : undefined}
            aria-describedby={action.fieldError ? `${id}-error` : undefined}
          />
          <Button type="submit" className="h-11 shrink-0" disabled={action.pending}>
            {action.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {action.pending ? "Reading the page" : "Import"}
          </Button>
        </div>
        {action.fieldError ? (
          <p id={`${id}-error`} className="text-sm text-destructive">
            {action.fieldError}
          </p>
        ) : null}
      </form>
    </section>
  )
}

export function ImportPanel({ appStore, listings, compact = false }: ImportPanelProps) {
  return (
    <div className="space-y-4">
      <div className={cn("grid grid-cols-1 gap-4", !compact && "lg:grid-cols-2")}>
        <AppStoreCard appStore={appStore} />
        <WebImportCard />
      </div>
      {listings.length > 0 ? (
        <section aria-label="Imported listings" className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Imported ({listings.length})
          </h2>
          <ul className="-mx-4 flex snap-x [scrollbar-width:none] gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
            {listings.map((listing) => (
              <li key={listing.id} className="w-28 shrink-0 snap-start">
                <Link href={`/app/products/${listing.id}`} className="group block space-y-1.5">
                  <span
                    className="relative block aspect-[3/4] overflow-hidden rounded-2xl ring-1 ring-black/5 dark:ring-white/10"
                    style={{ backgroundImage: listing.gradient }}
                  >
                    {listing.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- our own media route
                      <img
                        src={listing.coverUrl}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover object-top"
                      />
                    ) : listing.iconUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- our own media route
                      <img
                        src={listing.iconUrl}
                        alt=""
                        loading="lazy"
                        className="absolute inset-0 m-auto size-14 rounded-[24%]"
                      />
                    ) : (
                      <span className="absolute inset-0 flex items-center justify-center text-2xl font-semibold text-white">
                        {listing.initials}
                      </span>
                    )}
                    {listing.removed ? (
                      <span className="absolute inset-x-1 bottom-1 rounded-lg bg-black/60 px-1.5 py-0.5 text-center text-[10px] text-white">
                        Not in store
                      </span>
                    ) : null}
                  </span>
                  <span className="line-clamp-2 text-xs font-medium group-hover:underline">
                    {listing.title}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
