"use client"

import { CheckCircle2, Pause, Search } from "lucide-react"
import { useActionState, useId, useState } from "react"
import { toast } from "sonner"

import { FormActions, NativeSelect } from "@/components/profiles/form-kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  createLedgerAdjustmentAction,
  pauseLaunchForDisputeAction,
  resolveDisputeAction,
  reviewDisputeAction,
} from "@/lib/admin/actions"
import {
  ADJUSTMENT_REASON_MAX,
  DISPUTE_OUTCOMES,
  OUTCOME_HINTS,
  OUTCOME_LABELS,
  RESOLUTION_NOTE_MAX,
} from "@/lib/admin/fields"
import type { DisputeOutcome } from "@/lib/db/schema/enums"

import { ActionButton, ConfirmButton, ErrorText, Spinner, type Result } from "./action-kit"
import { AdjustmentLines, newLine, type LineDraft, type Party } from "./adjustment-lines"

/** /admin/disputes/[id] (Phase 6 acceptance: resolve with a note and an audited adjustment). */

export type OrderOption = { id: string; label: string }

export function ReviewDisputeButton({ disputeId }: { disputeId: string }) {
  return (
    <ActionButton
      run={() => reviewDisputeAction({ disputeId })}
      label="Take into review"
      icon={<Search aria-hidden="true" />}
      success="The members were told you're looking into it."
    />
  )
}

export function PauseForDisputeButton({ launchId, title }: { launchId: string; title: string }) {
  return (
    <ConfirmButton
      run={() => pauseLaunchForDisputeAction({ launchId })}
      label="Pause the launch"
      icon={<Pause aria-hidden="true" />}
      title={`Pause sales of “${title}” during the dispute?`}
      description="The product page says it's unavailable until an admin resumes it. Buyers keep their access."
      confirmLabel="Pause sales"
      success="Sales are paused."
    />
  )
}

function OrderPicker({
  id,
  orders,
  value,
  onChange,
}: {
  id: string
  orders: OrderOption[]
  value: string
  onChange: (value: string) => void
}) {
  if (orders.length === 0) return null
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Order (optional)</Label>
      <NativeSelect
        id={id}
        value={value}
        className="h-11 sm:h-9"
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Not tied to an order</option>
        {orders.map((order) => (
          <option key={order.id} value={order.id}>
            {order.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  )
}

function linesInput(lines: LineDraft[]) {
  return lines.map((line) => ({ party: line.party, amount: line.amount }))
}

/** Resolve: outcome, note, and with "Ledger adjustment" the lines, all in one action. */
export function ResolveDisputeForm({
  disputeId,
  parties,
  orders,
}: {
  disputeId: string
  parties: Party[]
  orders: OrderOption[]
}) {
  const id = useId()
  const [outcome, setOutcome] = useState<DisputeOutcome | "">("")
  const [note, setNote] = useState("")
  const [reason, setReason] = useState("")
  const [orderId, setOrderId] = useState("")
  const [lines, setLines] = useState<LineDraft[]>(() => [
    newLine(parties[0]?.id ?? ""),
    newLine(parties[1]?.id ?? ""),
  ])
  const [state, action, pending] = useActionState(async (): Promise<Result> => {
    const result = await resolveDisputeAction({
      disputeId,
      outcome: (outcome || undefined) as DisputeOutcome,
      note,
      adjustment:
        outcome === "adjusted"
          ? { orderId: orderId || undefined, reason, lines: linesInput(lines) }
          : undefined,
    })
    if (result.ok) toast.success("The dispute is resolved and the members were told.")
    return result
  }, null)
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined
  const noteError = fieldErrors?.note?.[0]
  const outcomeError = fieldErrors?.outcome?.[0]
  const adjustmentError = fieldErrors?.adjustment?.[0]

  return (
    <form action={action} className="space-y-5" noValidate>
      <fieldset
        className="space-y-2"
        aria-describedby={outcomeError ? `${id}-outcome-error` : undefined}
      >
        <legend className="text-sm font-medium">Outcome</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {DISPUTE_OUTCOMES.map((value) => (
            <label
              key={value}
              className="flex min-h-11 cursor-pointer flex-col gap-1 rounded-lg border bg-card p-3 text-sm has-[:checked]:border-primary has-[:checked]:ring-2 has-[:checked]:ring-primary/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
            >
              <span className="flex items-center gap-2 font-medium">
                <input
                  type="radio"
                  name="outcome"
                  value={value}
                  checked={outcome === value}
                  onChange={() => setOutcome(value)}
                  className="size-4 accent-primary"
                />
                {OUTCOME_LABELS[value]}
              </span>
              <span className="text-muted-foreground">{OUTCOME_HINTS[value]}</span>
            </label>
          ))}
        </div>
        {outcomeError ? (
          <p id={`${id}-outcome-error`} className="text-sm text-destructive">
            {outcomeError}
          </p>
        ) : null}
      </fieldset>

      {outcome === "adjusted" ? (
        <div className="space-y-4 rounded-lg border p-3">
          <OrderPicker id={`${id}-order`} orders={orders} value={orderId} onChange={setOrderId} />
          <AdjustmentLines parties={parties} lines={lines} onChange={setLines} />
          <div className="space-y-1">
            <Label htmlFor={`${id}-reason`}>Reason for the adjustment (audit log)</Label>
            <Input
              id={`${id}-reason`}
              value={reason}
              maxLength={ADJUSTMENT_REASON_MAX}
              className="h-11 sm:h-9"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {adjustmentError ? (
            <p role="alert" className="text-sm text-destructive">
              {adjustmentError}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor={`${id}-note`}>Note to the members</Label>
        <Textarea
          id={`${id}-note`}
          rows={4}
          value={note}
          maxLength={RESOLUTION_NOTE_MAX}
          aria-invalid={noteError ? true : undefined}
          aria-describedby={noteError ? `${id}-note-error` : undefined}
          onChange={(event) => setNote(event.target.value)}
        />
        {noteError ? (
          <p id={`${id}-note-error`} className="text-sm text-destructive">
            {noteError}
          </p>
        ) : null}
      </div>

      {!noteError && !outcomeError && !adjustmentError ? <ErrorText state={state} /> : null}
      <FormActions>
        <Button type="submit" disabled={pending} className="h-11 w-full sm:h-9 sm:w-auto">
          <Spinner pending={pending} icon={<CheckCircle2 aria-hidden="true" />} />
          Resolve the dispute
        </Button>
      </FormActions>
    </form>
  )
}

/**
 * An adjustment on its own (an extra one on a resolved dispute, or a correction from the payouts
 * page). Without a dispute or order, `parties` lists who may appear.
 */
export function LedgerAdjustmentForm({
  disputeId,
  parties,
  orders,
}: {
  disputeId?: string
  parties: Party[]
  orders: OrderOption[]
}) {
  const id = useId()
  const [reason, setReason] = useState("")
  const [orderId, setOrderId] = useState("")
  const [lines, setLines] = useState<LineDraft[]>(() => [
    newLine(parties[0]?.id ?? ""),
    newLine(parties[1]?.id ?? ""),
  ])
  const [state, action, pending] = useActionState(async (): Promise<Result> => {
    const result = await createLedgerAdjustmentAction({
      disputeId,
      orderId: orderId || undefined,
      reason,
      lines: linesInput(lines),
    })
    if (result.ok) {
      toast.success("Adjustment booked. It is payable in the next payout run.")
      setReason("")
      setLines([newLine(parties[0]?.id ?? ""), newLine(parties[1]?.id ?? "")])
    }
    return result
  }, null)
  const reasonError = state && !state.ok ? state.fieldErrors?.reason?.[0] : undefined
  return (
    <form action={action} className="space-y-4" noValidate>
      <OrderPicker id={`${id}-order`} orders={orders} value={orderId} onChange={setOrderId} />
      <AdjustmentLines parties={parties} lines={lines} onChange={setLines} />
      <div className="space-y-1">
        <Label htmlFor={`${id}-reason`}>Reason (audit log)</Label>
        <Input
          id={`${id}-reason`}
          value={reason}
          maxLength={ADJUSTMENT_REASON_MAX}
          className="h-11 sm:h-9"
          aria-invalid={reasonError ? true : undefined}
          aria-describedby={reasonError ? `${id}-reason-error` : undefined}
          onChange={(event) => setReason(event.target.value)}
        />
        {reasonError ? (
          <p id={`${id}-reason-error`} className="text-sm text-destructive">
            {reasonError}
          </p>
        ) : null}
      </div>
      {!reasonError ? <ErrorText state={state} /> : null}
      <Button type="submit" disabled={pending} className="h-11 w-full sm:h-9 sm:w-auto">
        <Spinner pending={pending} />
        Book the adjustment
      </Button>
    </form>
  )
}
