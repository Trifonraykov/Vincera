import { Sparkles } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { FeedList } from "@/components/feed/feed-list"
import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { canBrowseFeed } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { listFeed } from "@/lib/feed/queries"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"

export const metadata: Metadata = { title: "Feed" }

/**
 * The creator feed (`/app/feed`, beyond §12; CLAUDE.md §19.45): every open product as a big,
 * picture-first card in one scrolling column, best match first, then newest. Tap a card for its
 * screenshots and "Send a proposal"; the heart saves it.
 */
export default async function FeedPage() {
  const user = await requireOnboardedUser()
  if (!user.roles.includes("creator")) {
    return (
      <div className="mx-auto max-w-xl space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Feed</h1>
        <EmptyState
          icon={Sparkles}
          title="The feed is for creators"
          description="Creators scroll products here and pick the ones their audience would love."
          action={
            <Button asChild size="sm">
              <Link href={ONBOARDING_STEP_PATHS.role}>Become a creator</Link>
            </Button>
          }
        />
      </div>
    )
  }
  authorizePage(canBrowseFeed(user))
  const page = await listFeed(getDb(), { viewerId: user.id })

  return (
    <div className="mx-auto w-full max-w-[560px] space-y-5">
      <header className="flex items-end justify-between gap-4 px-1">
        <div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight">For you</h1>
          <p className="text-sm text-muted-foreground">Products looking for a creator like you.</p>
        </div>
        <Link
          href="/app/discover/saved"
          className="inline-flex h-11 items-center rounded-full px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Saved
        </Link>
      </header>
      {page.items.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing new right now"
          description="When builders list products, they show up here first."
        />
      ) : (
        <FeedList initialItems={page.items} initialCursor={page.nextCursor} />
      )}
    </div>
  )
}
