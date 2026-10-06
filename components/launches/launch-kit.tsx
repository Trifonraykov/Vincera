"use client"

import { Loader2, Sparkles } from "lucide-react"
import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"
import {
  LAUNCH_KIT_PLATFORM_LABELS,
  type LaunchKitOutput,
} from "@/lib/ai/prompts/launch-kit-shared"
import { generateLaunchKitAction } from "@/lib/launches/actions"

import { CopyButton } from "./copy-button"

type Result = ActionResult<{ kit: LaunchKitOutput }> | null

/**
 * The launch kit's post drafts (§7.3 use 4): "Write posts" asks Claude for three posts per
 * platform, each with the creator's tracked link, ready to copy. Never blocks: on failure the
 * page keeps the link and says to try again. Drafts are not stored; a new click writes new ones.
 */
export function LaunchKitGenerator({ launchId }: { launchId: string }) {
  const [state, action, pending] = useActionState(
    async (): Promise<Result> => generateLaunchKitAction({ launchId }),
    null,
  )
  const kit = state?.ok ? state.data.kit : null
  return (
    <div className="space-y-6">
      <form action={action} className="space-y-2">
        <Button type="submit" disabled={pending} className="h-11 w-full sm:h-9 sm:w-auto">
          {pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles aria-hidden="true" />
          )}
          {kit ? "Write new posts" : "Write posts"}
        </Button>
        {state && !state.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {pending ? "Writing posts…" : "Drafts by AI: read them before you post."}
        </p>
      </form>
      {kit ? (
        <div className="space-y-8">
          {kit.platforms.map((entry) => (
            <section
              key={entry.platform}
              aria-labelledby={`kit-${entry.platform}`}
              className="space-y-3"
            >
              <h2 id={`kit-${entry.platform}`} className="text-lg font-semibold">
                {LAUNCH_KIT_PLATFORM_LABELS[entry.platform].name}
              </h2>
              <ol className="space-y-3">
                {entry.posts.map((post, index) => (
                  <li key={index} className="space-y-3 rounded-xl border bg-card p-4 shadow-xs">
                    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      {post.angle}
                    </p>
                    <p className="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap">
                      {post.text}
                    </p>
                    <CopyButton
                      text={post.text}
                      label={`Copy ${LAUNCH_KIT_PLATFORM_LABELS[entry.platform].name} post ${index + 1}`}
                    >
                      Copy post
                    </CopyButton>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  )
}
