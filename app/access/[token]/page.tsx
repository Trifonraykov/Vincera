import { CircleSlash, Download, ExternalLink, FileText, KeyRound, Timer } from "lucide-react"
import type { Metadata } from "next"
import { headers } from "next/headers"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"

import { CopyButton } from "@/components/launches/copy-button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { requestCountry, userAgentHash } from "@/lib/attribution/request-context"
import { getDb } from "@/lib/db/client"
import { ACCESS_RATE_LIMIT, loadAccessView, recordAccessOpened } from "@/lib/delivery/access"
import { agreementDate } from "@/lib/agreements/template-v1"
import { clientIp, rateLimit } from "@/lib/ratelimit"
import { formatBytes } from "@/lib/storage/limits"

/**
 * The buyer's purchase (§12 `/access/[token]`; CLAUDE.md §19.31, §19.34): no account, the token in
 * the URL is the key. Dynamic and never cached; rate limited per IP (`access`, 60/min). Files are
 * downloaded through `/access/<token>/files/<fileId>` (5-minute signed URLs), license keys are
 * shown with a copy button, and URL deliveries redirect to their target. A revoked grant (full
 * refund or lost chargeback) says the purchase is no longer available; unknown tokens are 404s.
 * Every working visit records `access.opened` (no token, no email).
 */

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Your purchase" }

type Props = { params: Promise<{ token: string }> }

export default async function AccessPage({ params }: Props) {
  const { token } = await params
  const requestHeaders = await headers()
  const limit = await rateLimit("access", clientIp(requestHeaders), ACCESS_RATE_LIMIT)
  if (!limit.success) {
    return (
      <Alert>
        <Timer aria-hidden="true" />
        <AlertTitle>Too many requests</AlertTitle>
        <AlertDescription>Wait a minute, then reload this page.</AlertDescription>
      </Alert>
    )
  }

  const db = getDb()
  const view = await loadAccessView(db, token)
  if (!view) notFound()

  if (view.status === "revoked") {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight text-balance break-words">
          {view.launchTitle}
        </h1>
        <Alert>
          <CircleSlash aria-hidden="true" />
          <AlertTitle>This purchase is no longer available</AlertTitle>
          <AlertDescription>
            The order was refunded or reversed, so its access link stopped working. If you think
            this is a mistake, reply to your receipt email.
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  await recordAccessOpened(db, view, {
    ipCountry: requestCountry(requestHeaders),
    uaHash: userAgentHash(requestHeaders.get("user-agent")),
  })
  if (view.deliveryType === "url" && view.url) redirect(view.url)

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">Your purchase</p>
        <h1 className="text-2xl font-semibold tracking-tight text-balance break-words">
          {view.launchTitle}
        </h1>
        <p className="text-sm text-muted-foreground">
          Bought on {agreementDate(view.paidAt)}. Keep this page&apos;s link: it&apos;s how you get
          back here.
        </p>
      </header>

      {view.deliveryType === "file" ? (
        view.files.length > 0 ? (
          <section aria-labelledby="files-heading" className="space-y-3">
            <h2 id="files-heading" className="text-lg font-semibold">
              Your files
            </h2>
            <ul className="divide-y rounded-xl border bg-card">
              {view.files.map((file) => (
                <li key={file.id} className="flex flex-wrap items-center gap-3 p-4">
                  <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-all">{file.filename}</p>
                    <p className="text-sm text-muted-foreground">{formatBytes(file.sizeBytes)}</p>
                  </div>
                  <Button asChild className="h-11 w-full sm:w-auto md:h-9">
                    <a
                      href={`/access/${token}/files/${file.id}`}
                      rel="noreferrer"
                      aria-label={`Download ${file.filename}`}
                    >
                      <Download aria-hidden="true" />
                      Download
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Each download link is made when you click it and works for 5 minutes.
            </p>
          </section>
        ) : (
          <Alert>
            <FileText aria-hidden="true" />
            <AlertTitle>Your files are being prepared</AlertTitle>
            <AlertDescription>
              The makers haven&apos;t attached the files yet. Check back soon or reply to your
              receipt email.
            </AlertDescription>
          </Alert>
        )
      ) : null}

      {view.deliveryType === "license_key" ? (
        view.licenseKey ? (
          <section aria-labelledby="key-heading" className="space-y-3">
            <h2 id="key-heading" className="text-lg font-semibold">
              Your license key
            </h2>
            <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center">
              <KeyRound
                className="hidden size-5 shrink-0 text-muted-foreground sm:block"
                aria-hidden="true"
              />
              <code className="min-w-0 flex-1 rounded-md bg-muted px-3 py-2 font-mono text-base break-all select-all">
                {view.licenseKey}
              </code>
              <CopyButton text={view.licenseKey} label="Copy your license key" />
            </div>
            {view.instructions ? (
              <p className="text-sm whitespace-pre-line text-muted-foreground">
                {view.instructions}
              </p>
            ) : null}
          </section>
        ) : (
          <Alert>
            <KeyRound aria-hidden="true" />
            <AlertTitle>Your license key is on its way</AlertTitle>
            <AlertDescription>
              All keys were taken when you paid. The makers have been told; reload this page later
              to get yours. You won&apos;t be charged again.
            </AlertDescription>
          </Alert>
        )
      ) : null}

      {view.deliveryType === "url" ? (
        <Alert>
          <ExternalLink aria-hidden="true" />
          <AlertTitle>Link not available</AlertTitle>
          <AlertDescription>
            This product&apos;s link is missing. Reply to your receipt email and the makers will
            help.
          </AlertDescription>
        </Alert>
      ) : null}

      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <Link href={`/p/${view.slug}`} className="underline underline-offset-4">
          View the product page
        </Link>
        <Link href={`/access/${token}/refund`} className="underline underline-offset-4">
          Ask for a refund
        </Link>
      </p>
    </div>
  )
}
