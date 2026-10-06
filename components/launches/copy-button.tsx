"use client"

import { Check, Copy } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Copies `text` to the clipboard (tracked links, launch kit posts). A 44 px target on phones; the
 * label says what is copied for screen readers, and a toast confirms it.
 */
export function CopyButton({
  text,
  label,
  children = "Copy",
  className,
  variant = "outline",
}: {
  text: string
  /** Accessible name, e.g. "Copy your tracked link". */
  label: string
  children?: React.ReactNode
  className?: string
  variant?: "outline" | "default" | "secondary" | "ghost"
}) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      toast.success("Copied.")
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Couldn't copy. Select the text and copy it yourself.")
    }
  }
  return (
    <Button
      type="button"
      variant={variant}
      onClick={copy}
      aria-label={label}
      className={cn("h-11 md:h-9", className)}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {children}
    </Button>
  )
}
