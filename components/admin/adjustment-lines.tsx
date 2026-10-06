"use client"

import { Plus, Trash2 } from "lucide-react"
import { useId } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/profiles/form-kit"
import { ADJUSTMENT_MAX_LINES, parseSignedCents } from "@/lib/admin/fields"

/**
 * The lines of a ledger adjustment (CLAUDE.md §19.38): who (a member, or the platform) and a
 * signed amount in euros. A running total shows whether the lines sum to zero, which the server
 * requires. Controlled by the parent form.
 */

export type Party = { id: string; label: string }
export type LineDraft = { key: string; party: string; amount: string }

let counter = 0
export function newLine(party = ""): LineDraft {
  counter += 1
  return { key: `line-${counter}`, party, amount: "" }
}

export function linesTotalCents(lines: LineDraft[]): number | null {
  let total = 0
  for (const line of lines) {
    const cents = parseSignedCents(line.amount)
    if (cents === null) return null
    total += cents
  }
  return total
}

export function AdjustmentLines({
  parties,
  lines,
  onChange,
}: {
  parties: Party[]
  lines: LineDraft[]
  onChange: (lines: LineDraft[]) => void
}) {
  const id = useId()
  const total = linesTotalCents(lines)
  const update = (key: string, patch: Partial<LineDraft>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)))
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Lines</legend>
      <p className="text-sm text-muted-foreground">
        Negative takes money from someone, positive gives it. The lines must add up to zero, for
        example −5 from the creator and +5 to the builder.
      </p>
      <ul className="space-y-3">
        {lines.map((line, index) => (
          <li key={line.key} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_9rem_auto]">
            <div className="space-y-1">
              <Label htmlFor={`${id}-${line.key}-party`}>Line {index + 1}: who</Label>
              <NativeSelect
                id={`${id}-${line.key}-party`}
                value={line.party}
                className="h-11 sm:h-9"
                onChange={(event) => update(line.key, { party: event.target.value })}
              >
                <option value="">Choose…</option>
                {parties.map((party) => (
                  <option key={party.id} value={party.id}>
                    {party.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-${line.key}-amount`}>Amount (€)</Label>
              <Input
                id={`${id}-${line.key}-amount`}
                inputMode="decimal"
                autoComplete="off"
                value={line.amount}
                placeholder="-5.00"
                className="h-11 sm:h-9"
                onChange={(event) => update(line.key, { amount: event.target.value })}
              />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 sm:size-9"
                aria-label={`Remove line ${index + 1}`}
                disabled={lines.length <= 2}
                onClick={() => onChange(lines.filter((other) => other.key !== line.key))}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11 sm:h-9"
          disabled={lines.length >= ADJUSTMENT_MAX_LINES}
          onClick={() => onChange([...lines, newLine()])}
        >
          <Plus aria-hidden="true" />
          Add a line
        </Button>
        <p className="text-sm tabular-nums" aria-live="polite">
          Total:{" "}
          {total === null ? (
            <span className="text-muted-foreground">—</span>
          ) : total === 0 ? (
            <span className="font-medium">€0.00 · balanced</span>
          ) : (
            <span className="font-medium text-destructive">
              {(total / 100).toFixed(2)} · must be 0
            </span>
          )}
        </p>
      </div>
    </fieldset>
  )
}
