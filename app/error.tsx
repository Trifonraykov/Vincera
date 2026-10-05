"use client"

import { ShellError, type ErrorBoundaryProps } from "@/components/layout/shell-error"
import { LogoMark } from "@/components/shared/logo"

/**
 * Errors outside the app and admin shells (onboarding, public profiles, marketing, and a failing
 * app or admin layout), with a way back to the home page. The root layout stays in place.
 */
export default function RootError(props: ErrorBoundaryProps) {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-svh w-full max-w-xl flex-col justify-center gap-6 px-4 py-10"
    >
      <LogoMark className="size-8" />
      <ShellError {...props} homeHref="/" homeLabel="Go to the home page" />
    </main>
  )
}
