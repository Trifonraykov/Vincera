"use client"

import { Loader2, Unplug } from "lucide-react"
import { useActionState, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import type { ActionResult } from "@/lib/actions/result"
import { disconnectSocialConnection } from "@/lib/social/actions"
import type { SocialProviderId } from "@/lib/social/types"

/**
 * "Disconnect" with a confirmation (§14): the connection, its tokens and every stored snapshot
 * are deleted; access is revoked at the provider where it can be.
 */
export function DisconnectButton({
  connectionId,
  label,
  manual,
}: {
  connectionId: string
  label: string
  /** Manual entries have no provider access to revoke. */
  manual: boolean
}) {
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<{ provider: SocialProviderId }> | null, formData: FormData) => {
      const result = await disconnectSocialConnection(formData)
      if (result.ok) setOpen(false)
      return result
    },
    null,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
          <Unplug aria-hidden="true" />
          Disconnect
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect {label}?</DialogTitle>
          <DialogDescription>
            {manual
              ? `We'll delete the ${label} numbers and screenshot you entered. Your profile stops showing them.`
              : `We'll delete our access to your ${label} account and every stat we stored from it. Your profile stops showing ${label} numbers. You can connect it again any time.`}
          </DialogDescription>
        </DialogHeader>
        {state && !state.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        <form action={formAction}>
          <input type="hidden" name="connectionId" value={connectionId} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Keep it
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Disconnect and delete data
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
