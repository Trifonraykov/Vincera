"use client"

import { ChevronDown, Loader2, Sparkles } from "lucide-react"
import { useActionState, useId, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { ActionResult } from "@/lib/actions/result"
import { draftIdeaBriefAction, type IdeaBriefActionResult } from "@/lib/ideas/actions"
import { IDEA_COMMENTS_MAX } from "@/lib/ideas/fields"
import { formatMoneyInput } from "@/lib/money-input"
import { SUPPLY_CURRENCY } from "@/lib/supply/fields"
import { cn } from "@/lib/utils"

import { EMPTY_IDEA_DEFAULTS, IdeaForm, type IdeaFormDefaults } from "./idea-form"

type BriefState = { result: ActionResult<IdeaBriefActionResult>; comments: string } | null

/**
 * `/app/ideas/new`: the idea brief drafter (§7.3.2) above the idea form. Pasting audience
 * comments and pressing "Draft my idea" fills the form with a brief from Claude; everything stays
 * editable and nothing is saved until the creator presses Save or Publish. If the model fails, the
 * form simply stays empty (never blocks, §7.3).
 */
export function NewIdea() {
  const id = useId()
  const [defaults, setDefaults] = useState<IdeaFormDefaults>(EMPTY_IDEA_DEFAULTS)
  const [briefToken, setBriefToken] = useState<string | null>(null)
  const [formKey, setFormKey] = useState(0)
  const [open, setOpen] = useState(true)

  const [state, draftAction, drafting] = useActionState(
    async (_previous: BriefState, formData: FormData): Promise<BriefState> => {
      const comments =
        typeof formData.get("comments") === "string" ? String(formData.get("comments")) : ""
      const result = await draftIdeaBriefAction(formData)
      if (result.ok) {
        const { draft, token } = result.data
        setDefaults({
          title: draft.title,
          problem: draft.problem,
          audienceEvidence: draft.audienceEvidence,
          format: draft.format ?? "",
          targetPrice: formatMoneyInput(draft.targetPriceCents, SUPPLY_CURRENCY),
          topics: draft.topics,
        })
        setBriefToken(token)
        setFormKey((key) => key + 1)
        setOpen(false)
      }
      return { result, comments }
    },
    null,
  )
  const failed = state && !state.result.ok ? state.result : null
  const drafted = state?.result.ok === true
  const commentsId = `${id}-comments`
  const panelId = `${id}-panel`
  const commentsError = failed?.fieldErrors?.comments?.[0]

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-primary" aria-hidden="true" />
            Draft it from your audience&apos;s comments
          </CardTitle>
          <CardDescription>
            Paste comments, DMs or poll answers where people ask for something. We&apos;ll turn them
            into a first draft you can edit.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {drafted ? (
            <Alert>
              <Sparkles aria-hidden="true" />
              <AlertDescription>
                Drafted from your comments. Read it through and change anything before you save.
              </AlertDescription>
            </Alert>
          ) : null}
          {drafted ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((value) => !value)}
            >
              <ChevronDown
                className={cn("transition-transform", open && "rotate-180")}
                aria-hidden="true"
              />
              {open ? "Hide the comments" : "Draft again from other comments"}
            </Button>
          ) : null}
          <form
            id={panelId}
            action={draftAction}
            noValidate
            className={cn("space-y-3", drafted && !open && "hidden")}
          >
            <div className="space-y-2">
              <Label htmlFor={commentsId}>Audience comments</Label>
              <Textarea
                id={commentsId}
                name="comments"
                rows={6}
                maxLength={IDEA_COMMENTS_MAX}
                defaultValue={failed ? (state?.comments ?? "") : ""}
                placeholder={
                  "Can you make a budget template for students?\nI never know where my money goes by the 20th…"
                }
                aria-describedby={commentsError ? `${commentsId}-error` : `${commentsId}-hint`}
                aria-invalid={commentsError ? true : undefined}
              />
              {commentsError ? (
                <p id={`${commentsId}-error`} className="text-sm text-destructive">
                  {commentsError}
                </p>
              ) : (
                <p id={`${commentsId}-hint`} className="text-sm text-muted-foreground">
                  One comment per line works best. We don&apos;t store the comments.
                </p>
              )}
            </div>
            {failed && !commentsError ? (
              <p role="alert" className="text-sm text-destructive">
                {failed.error}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="secondary"
              disabled={drafting}
              className="w-full sm:w-auto"
            >
              {drafting ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles aria-hidden="true" />
              )}
              {drafting ? "Drafting…" : "Draft my idea"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <IdeaForm key={formKey} mode="create" defaults={defaults} briefToken={briefToken} />
    </div>
  )
}
