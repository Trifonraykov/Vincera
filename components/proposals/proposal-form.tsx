"use client"

import { Loader2, Send } from "lucide-react"
import { useEffect, useId, useRef } from "react"
import { toast } from "sonner"

import {
  describe,
  Field,
  FormActions,
  FormErrorAlert,
  useFormAction,
} from "@/components/profiles/form-kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { counterProposalAction, sendProposalAction } from "@/lib/proposals/actions"
import {
  PROPOSAL_MESSAGE_MAX,
  PROPOSAL_SCOPE_MAX,
  TIMELINE_WEEKS_MAX,
  TIMELINE_WEEKS_MIN,
} from "@/lib/proposals/fields"

import { SplitField } from "./split-field"

export type ProposalFormDefaults = {
  scope: string
  message: string
  creatorSplitPct: number
  timelineWeeks: number
}

type Props = {
  defaults: ProposalFormDefaults
  /** Extra classes for the action bar (e.g. `bottom-0` inside a sheet, which has no tab bar). */
  actionsClassName?: string
} & (
  | {
      mode: "send"
      /** `to`, `targetKind`, `targetId` and optionally `match`. */
      hidden: { to: string; targetKind: "idea" | "product"; targetId: string; match?: string }
    }
  | {
      mode: "counter"
      hidden: { proposalId: string; revisionId: string }
      onDone: () => void
      onCancel: () => void
    }
)

const FIELDS = ["message", "scope", "creatorSplitPct", "builderSplitPct", "timelineWeeks"] as const

/**
 * The terms of an offer: a new proposal (`/app/proposals/new`) or a counter-offer on the proposal
 * page. Message, scope, the linked split slider and the timeline; the submit button sits in the
 * sticky action bar on phones. A refused submit keeps what was typed (`useFormAction`).
 */
export function ProposalForm(props: Props) {
  const id = useId()
  const form = useFormAction(props.mode === "send" ? sendProposalAction : counterProposalAction)
  const { defaults } = props
  const handled = useRef<unknown>(null)
  const onDone = props.mode === "counter" ? props.onDone : null

  useEffect(() => {
    if (!onDone || !form.result?.ok || handled.current === form.result) return
    handled.current = form.result
    toast.success("Counter-offer sent. It's their turn now.")
    onDone()
  }, [form.result, onDone])

  const scopeError = form.fieldError("scope")
  const messageError = form.fieldError("message")
  const timelineError = form.fieldError("timelineWeeks")
  const splitError = form.fieldError("creatorSplitPct") ?? form.fieldError("builderSplitPct")

  return (
    <form action={form.formAction} noValidate className="space-y-6">
      {Object.entries(props.hidden).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
      {form.error && form.hasFormError(FIELDS) ? (
        <FormErrorAlert message={form.error.error} />
      ) : null}

      <Field
        id={`${id}-scope`}
        label="What you'll build together"
        hint="The product, what's in the first version, and who does what."
        error={scopeError}
      >
        <Textarea
          id={`${id}-scope`}
          name="scope"
          required
          rows={5}
          maxLength={PROPOSAL_SCOPE_MAX}
          defaultValue={form.valueOf("scope", defaults.scope)}
          {...describe(`${id}-scope`, { hint: true, error: scopeError })}
        />
      </Field>

      {/* Controlled inside, so it keeps its value when a refused submit resets the form. */}
      <SplitField defaultCreatorPct={defaults.creatorSplitPct} error={splitError} />

      <Field
        id={`${id}-timeline`}
        label="Timeline (weeks)"
        hint="How long until a first version is ready to launch."
        error={timelineError}
      >
        <Input
          id={`${id}-timeline`}
          name="timelineWeeks"
          type="number"
          inputMode="numeric"
          min={TIMELINE_WEEKS_MIN}
          max={TIMELINE_WEEKS_MAX}
          step={1}
          required
          className="h-11 max-w-32 tabular-nums"
          defaultValue={form.valueOf("timelineWeeks", String(defaults.timelineWeeks))}
          {...describe(`${id}-timeline`, { hint: true, error: timelineError })}
        />
      </Field>

      <Field
        id={`${id}-message`}
        label={props.mode === "send" ? "Message" : "Note to them"}
        optional
        hint={
          props.mode === "send"
            ? "Introduce yourself and say why you're a good fit."
            : "What changed and why."
        }
        error={messageError}
      >
        <Textarea
          id={`${id}-message`}
          name="message"
          rows={4}
          maxLength={PROPOSAL_MESSAGE_MAX}
          defaultValue={form.valueOf("message", defaults.message)}
          {...describe(`${id}-message`, { hint: true, error: messageError })}
        />
      </Field>

      <FormActions className={props.actionsClassName}>
        {props.mode === "counter" ? (
          <Button
            type="button"
            variant="outline"
            onClick={props.onCancel}
            disabled={form.pending}
            className="h-11 sm:h-9"
          >
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={form.pending} className="h-11 sm:h-9">
          {form.pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Send aria-hidden="true" />
          )}
          {props.mode === "send" ? "Send proposal" : "Send counter-offer"}
        </Button>
      </FormActions>
    </form>
  )
}
