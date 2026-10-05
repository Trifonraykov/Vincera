"use client"

import { ThemeProvider as NextThemesProvider } from "next-themes"
import type * as React from "react"

/**
 * next-themes renders an inline <script> that sets the theme class before the first paint. It
 * runs from the server's HTML; when React renders the provider in the browser instead of
 * hydrating it (Next does for not-found pages), React 19 reports "Encountered a script tag while
 * rendering React component" as an error. In the browser the script is inert anyway, so it gets
 * a non-executable type there (`suppressHydrationWarning` is set on it, so hydration ignores the
 * difference).
 */
const scriptProps =
  typeof window === "undefined" ? undefined : ({ type: "application/json" } as const)

/** Light / dark / system theme via a `class` on <html> (matches `.dark` in globals.css). */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      scriptProps={scriptProps}
    >
      {children}
    </NextThemesProvider>
  )
}
