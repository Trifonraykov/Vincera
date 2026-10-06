import { ShellNotFound } from "@/components/layout/shell-not-found"

/** 404 inside the admin shell (see app/admin/[...missing]/page.tsx). */
export default function AdminNotFound() {
  return <ShellNotFound homeHref="/admin" />
}
