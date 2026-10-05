"use client"

import { ShellError, type ErrorBoundaryProps } from "@/components/layout/shell-error"

/** Errors in an admin page, shown inside the admin shell. */
export default function AdminError(props: ErrorBoundaryProps) {
  return <ShellError {...props} homeHref="/admin" homeLabel="Go to admin home" />
}
