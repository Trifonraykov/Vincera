"use client"

import { useId, useState } from "react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { complementPct } from "@/lib/proposals/fields"
import { cn } from "@/lib/utils"

/**
 * The revenue split (§5 proposal_revisions: creator % + builder % = 100): one slider for the
 * creator's share and two number fields that stay linked, so the shares always add up to 100.
 * Both numbers are submitted (`creatorSplitPct`, `builderSplitPct`); the server checks the sum
 * again. The slider is a native range input: keyboard, screen reader and touch work everywhere.
 */
export function SplitField({
  defaultCreatorPct,
  error,
}: {
  defaultCreatorPct: number
  error?: string
}) {
  const id = useId()
  const [creator, setCreator] = useState<number>(defaultCreatorPct)
  const builder = complementPct(creator)

  function fromInput(raw: string, side: "creator" | "builder") {
    const value = Number.parseInt(raw, 10)
    if (Number.isNaN(value)) return
    const clamped = Math.min(100, Math.max(0, value))
    setCreator(side === "creator" ? clamped : complementPct(clamped))
  }

  const describedBy = [`${id}-hint`, error ? `${id}-error` : null].filter(Boolean).join(" ")

  return (
    <fieldset className="space-y-3" aria-describedby={describedBy}>
      <legend className="text-sm leading-none font-medium">Revenue split</legend>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span>
          Creator <span className="font-semibold tabular-nums">{creator}%</span>
        </span>
        <span>
          Builder <span className="font-semibold tabular-nums">{builder}%</span>
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={creator}
        onChange={(event) => setCreator(Number(event.target.value))}
        aria-label="Creator's share"
        aria-valuetext={`Creator ${creator}%, builder ${builder}%`}
        className="h-11 w-full cursor-pointer accent-primary"
      />
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-creator`}>Creator %</Label>
          <Input
            id={`${id}-creator`}
            name="creatorSplitPct"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={creator}
            onChange={(event) => fromInput(event.target.value, "creator")}
            aria-invalid={error ? true : undefined}
            className="h-11 tabular-nums"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-builder`}>Builder %</Label>
          <Input
            id={`${id}-builder`}
            name="builderSplitPct"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={builder}
            onChange={(event) => fromInput(event.target.value, "builder")}
            aria-invalid={error ? true : undefined}
            className="h-11 tabular-nums"
          />
        </div>
      </div>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        Shares of what each sale earns after tax, fees and the platform&apos;s cut. They always add
        up to 100%.
      </p>
      {error ? (
        <p id={`${id}-error`} className={cn("text-sm text-destructive")}>
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}
