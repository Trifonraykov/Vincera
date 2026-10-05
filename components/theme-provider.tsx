"use client"

import { ThemeProvider as NextThemesProvider } from "next-themes"
import type * as React from "react"

/** Light / dark / system theme via a `class` on <html> (matches `.dark` in globals.css). */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  )
}
