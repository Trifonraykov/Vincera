"use client"

import { Loader2, RefreshCw } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { refreshMyMatchesAction } from "@/lib/matching/actions"
import type { AppRole } from "@/lib/nav"
import { cn } from "@/lib/utils"

/** "Update my matches": recompute now (rate-limited), then show the new list. */
export function RefreshMatchesButton({
  role,
  variant = "outline",
  className,
}: {
  role: AppRole
  variant?: "outline" | "default"
  className?: string
}) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  return (
    <Button
      type="button"
      variant={variant}
      className={cn("h-11 sm:h-9", className)}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await refreshMyMatchesAction({ role })
          if (!result.ok) {
            toast.error(result.error)
            return
          }
          toast.success(
            result.data.stored > 0
              ? "Your matches are up to date."
              : "No matches yet. Check back soon.",
          )
          router.refresh()
        })
      }
    >
      {pending ? (
        <Loader2 className="animate-spin" aria-hidden="true" />
      ) : (
        <RefreshCw aria-hidden="true" />
      )}
      Update my matches
    </Button>
  )
}
