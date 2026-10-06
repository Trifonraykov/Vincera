"use client"

import { useTheme } from "next-themes"
import { useEffect } from "react"

import { THEME_COLORS } from "@/lib/pwa/icons"

const THEME_COLOR_META = 'meta[name="theme-color"]'

/**
 * Keeps the browser and status bar colour (`<meta name="theme-color">`) on the theme the person
 * picked in the app. The root viewport's tags (one per `prefers-color-scheme`) follow the system
 * setting, which is wrong when someone chose dark on a light phone or the other way round, so
 * both get the chosen colour.
 *
 * Next re-renders those tags on every client-side navigation, putting the system's colours back;
 * a MutationObserver on <head> re-applies the choice whenever they change or are replaced.
 * Mounted once in the root layout (inside ThemeProvider), so every page has it: the app, sign-in,
 * onboarding, public profiles and the marketing site.
 */
export function ThemeColorSync() {
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return
    const color = THEME_COLORS[resolvedTheme]
    const apply = () => {
      for (const meta of document.querySelectorAll<HTMLMetaElement>(THEME_COLOR_META)) {
        // Only when different: writing the attribute again would wake the observer forever.
        if (meta.content !== color) meta.content = color
      }
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.head, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["content"],
    })
    return () => observer.disconnect()
  }, [resolvedTheme])

  return null
}
