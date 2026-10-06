"use client"

import { Monitor, Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { useSyncExternalStore } from "react"

import { cn } from "@/lib/utils"

const CHOICES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Auto", icon: Monitor },
] as const

const noSubscribe = () => () => undefined

/**
 * Light / dark / automatic as a segmented control (the Me page's Appearance row): on phones the
 * theme lives here rather than in a header dropdown. Toggle buttons (`aria-pressed`), 44 px tall.
 */
export function ThemeChoice() {
  const { theme, setTheme } = useTheme()
  // next-themes only knows the stored theme in the browser; render it unselected until then.
  const mounted = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  )
  const current = mounted ? (theme ?? "system") : null

  return (
    <div
      role="group"
      aria-label="Appearance"
      className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1"
    >
      {CHOICES.map(({ value, label, icon: Icon }) => {
        const selected = current === value
        return (
          <button
            key={value}
            type="button"
            aria-pressed={selected}
            onClick={() => setTheme(value)}
            className={cn(
              "flex min-h-11 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none",
              selected
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </button>
        )
      })}
    </div>
  )
}
