import { ShellNotFound } from "@/components/layout/shell-not-found"

/** 404 inside the app shell (see app/app/[...missing]/page.tsx). */
export default function AppNotFound() {
  return <ShellNotFound homeHref="/app" />
}
