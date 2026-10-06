import type { ComponentProps } from "react"

import { Input } from "@/components/ui/input"
import { currencySymbol } from "@/lib/money-input"
import { cn } from "@/lib/utils"

/**
 * A price field: the currency symbol in front, a decimal keyboard on phones, and the typed text
 * sent as it is (`"19.99"`, `"19,99"`); the server turns it into integer cents
 * (lib/money-input.ts), so a float never reaches the database (§0).
 */
export function MoneyInput({
  currency,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "type" | "inputMode"> & { currency: string }) {
  const symbol = currencySymbol(currency)
  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground"
      >
        {symbol}
      </span>
      <Input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        className={cn("pl-7 tabular-nums", className)}
        {...props}
      />
    </div>
  )
}
