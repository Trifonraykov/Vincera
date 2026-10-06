"use client"

import { Flag, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import {
  describe,
  Field,
  FormActions,
  FormErrorAlert,
  useFormAction,
} from "@/components/profiles/form-kit"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { useIsMobile } from "@/hooks/use-mobile"
import { raiseDisputeAction } from "@/lib/disputes/actions"
import {
  DISPUTE_DESCRIPTION_MAX,
  DISPUTE_KIND_HINTS,
  DISPUTE_KIND_LABELS,
  DISPUTE_KINDS,
} from "@/lib/disputes/fields"
import { cn } from "@/lib/utils"

/**
 * "Raise a dispute" (CLAUDE.md §19.40): a bottom sheet on phones, a side sheet from `md` up, with
 * the kind (radio cards) and a description. The other member and our team are notified.
 */
export function RaiseDisputeSheet({ collabId }: { collabId: string }) {
  const [open, setOpen] = useState(false)
  const isMobile = useIsMobile()

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" className="h-11 w-full sm:h-9 sm:w-auto">
          <Flag aria-hidden="true" />
          Raise a dispute
        </Button>
      </SheetTrigger>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "gap-0 overflow-y-auto overscroll-contain",
          isMobile ? "max-h-[92dvh] rounded-t-2xl pb-safe-2" : "w-full sm:max-w-lg",
        )}
      >
        <SheetHeader>
          <SheetTitle>Raise a dispute</SheetTitle>
          <SheetDescription>
            Tell our team what went wrong. Your collaborator sees that you raised it and what it is
            about; we may message you both before deciding.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          {open ? <RaiseDisputeForm collabId={collabId} onDone={() => setOpen(false)} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function RaiseDisputeForm({ collabId, onDone }: { collabId: string; onDone: () => void }) {
  const form = useFormAction(raiseDisputeAction)
  const [length, setLength] = useState(0)
  const kindError = form.fieldError("kind")
  const descriptionError = form.fieldError("description")

  useEffect(() => {
    if (form.result?.ok) {
      toast.success("Dispute raised. Our team will look into it.")
      onDone()
    }
  }, [form.result, onDone])

  return (
    <form action={form.formAction} noValidate className="space-y-5">
      <input type="hidden" name="collabId" value={collabId} />
      {form.hasFormError(["kind", "description"]) && form.error ? (
        <FormErrorAlert message={form.error.error} />
      ) : null}

      <fieldset
        className="space-y-2"
        aria-describedby={kindError ? "dispute-kind-error" : undefined}
        aria-invalid={kindError ? true : undefined}
      >
        <legend className="mb-2 text-sm font-medium">What is it about?</legend>
        {DISPUTE_KINDS.map((kind) => (
          <label
            key={kind}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
          >
            <input
              type="radio"
              name="kind"
              value={kind}
              defaultChecked={form.valueOf("kind", "") === kind}
              className="mt-1 size-4 accent-primary"
              aria-describedby={`dispute-kind-${kind}-hint`}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{DISPUTE_KIND_LABELS[kind]}</span>
              <span
                id={`dispute-kind-${kind}-hint`}
                className="block text-sm text-muted-foreground"
              >
                {DISPUTE_KIND_HINTS[kind]}
              </span>
            </span>
          </label>
        ))}
        {kindError ? (
          <p id="dispute-kind-error" className="text-sm text-destructive">
            {kindError}
          </p>
        ) : null}
      </fieldset>

      <Field
        id="dispute-description"
        label="What happened?"
        hint={`${length} / ${DISPUTE_DESCRIPTION_MAX} characters. Facts and dates help us most. Don't include passwords or card numbers.`}
        error={descriptionError}
      >
        <Textarea
          id="dispute-description"
          name="description"
          rows={6}
          maxLength={DISPUTE_DESCRIPTION_MAX}
          defaultValue={form.valueOf("description", "")}
          onChange={(event) => setLength(event.target.value.length)}
          {...describe("dispute-description", { hint: true, error: descriptionError })}
        />
      </Field>

      <FormActions className="bottom-0">
        <Button type="submit" variant="destructive" disabled={form.pending} className="h-11 sm:h-9">
          {form.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Raise the dispute
        </Button>
      </FormActions>
    </form>
  )
}
