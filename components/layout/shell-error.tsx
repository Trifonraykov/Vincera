"use client"

import * as Sentry from "@sentry/nextjs"
import { TriangleAlert } from "lucide-react"
import Link from "next/link"
import { useEffect } from "react"

import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"

export type ErrorBoundaryProps = {
  error: Error & { digest?: string }
  retry: () => void
}

/**
 * Fallback for an error boundary (`error.tsx`): a plain-language message, "Try again" (Next's
 * `retry` re-fetches and re-renders the segment) and a way home. Inside the app shell the sidebar
 * and tab bar stay on screen.
 *
 * Server errors arrive with a `digest` and were already reported by `onRequestError`
 * (instrumentation.ts); errors thrown while rendering in the browser have none and are reported
 * here (a no-op without a Sentry DSN).
 */
export function ShellError({
  error,
  retry,
  homeHref,
  homeLabel = "Go to home",
}: ErrorBoundaryProps & { homeHref: string; homeLabel?: string }) {
  useEffect(() => {
    if (!error.digest) Sentry.captureException(error)
  }, [error])

  return (
    <div className="space-y-8">
      <PageHeader title="Something went wrong" />
      <EmptyState
        icon={TriangleAlert}
        title="We couldn't load this page"
        description="Try again in a moment. If it keeps happening, please come back later."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" size="sm" onClick={() => retry()}>
              Try again
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href={homeHref}>{homeLabel}</Link>
            </Button>
          </div>
        }
      />
    </div>
  )
}
