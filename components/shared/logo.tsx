import Link from "next/link"

import { cn } from "@/lib/utils"

/** The two overlapping squares: a creator and a builder making one thing. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("size-6 shrink-0", className)}
      fill="none"
    >
      <rect x="2" y="2" width="13" height="13" rx="3.5" className="fill-foreground" />
      <rect
        x="9"
        y="9"
        width="13"
        height="13"
        rx="3.5"
        className="fill-primary/25 stroke-foreground"
        strokeWidth="1.5"
      />
    </svg>
  )
}

export function Logo({
  appName,
  href = "/",
  className,
}: {
  appName: string
  href?: string
  className?: string
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
    >
      <LogoMark />
      <span className="truncate">{appName}</span>
    </Link>
  )
}
