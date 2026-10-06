"use client"

import { ShellError, type ErrorBoundaryProps } from "@/components/layout/shell-error"

/** Errors in an app page, shown inside the app shell so the menu and tab bar stay usable. */
export default function AppError(props: ErrorBoundaryProps) {
  return <ShellError {...props} homeHref="/app" />
}
