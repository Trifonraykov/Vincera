"use client"

import { CheckCheck, Loader2 } from "lucide-react"
import { useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { markAllNotificationsReadAction } from "@/lib/notifications/actions"

/** "Mark all as read" on `/app/notifications`; the list and the bell refresh with the action. */
export function MarkAllReadButton({ disabled }: { disabled: boolean }) {
  const [pending, startTransition] = useTransition()
  return (
    <Button
      variant="outline"
      className="h-11 sm:h-9"
      disabled={disabled || pending}
      onClick={() =>
        startTransition(async () => {
          const result = await markAllNotificationsReadAction({})
          if (!result.ok) toast.error(result.error)
        })
      }
    >
      {pending ? (
        <Loader2 className="animate-spin" aria-hidden="true" />
      ) : (
        <CheckCheck aria-hidden="true" />
      )}
      Mark all as read
    </Button>
  )
}
