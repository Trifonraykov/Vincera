"use client"

import { BadgeCheck, Eye, ShieldMinus, ShieldPlus, UserCheck, UserX } from "lucide-react"
import { useActionState, useId, useState } from "react"

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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  grantAdminAction,
  revokeAdminAction,
  startImpersonationAction,
  suspendUserAction,
  unsuspendUserAction,
} from "@/lib/admin/actions"
import { IMPERSONATION_REASON_MAX } from "@/lib/admin/fields"
import { verifySocialConnection } from "@/lib/social/actions"

import {
  ActionButton,
  ConfirmButton,
  ErrorText,
  fullOnPhone,
  Spinner,
  type Result,
} from "./action-kit"

/** The actions on /admin/users/[id] (Phase 6; CLAUDE.md §19.38 "Users (admin)"). */

export function SuspendButton({ userId, name }: { userId: string; name: string }) {
  return (
    <ConfirmButton
      run={() => suspendUserAction({ userId })}
      label="Suspend"
      icon={<UserX aria-hidden="true" />}
      title={`Suspend ${name}?`}
      description="They are signed out everywhere at once and can't sign in again until you lift the suspension. Their collabs, launches and money stay as they are."
      confirmLabel="Suspend the account"
      confirmVariant="destructive"
      success="The account is suspended."
    />
  )
}

export function UnsuspendButton({ userId }: { userId: string }) {
  return (
    <ActionButton
      run={() => unsuspendUserAction({ userId })}
      label="Lift the suspension"
      icon={<UserCheck aria-hidden="true" />}
      success="They can sign in again."
      variant="outline"
    />
  )
}

export function GrantAdminButton({ userId, name }: { userId: string; name: string }) {
  return (
    <ConfirmButton
      run={() => grantAdminAction({ userId })}
      label="Make admin"
      icon={<ShieldPlus aria-hidden="true" />}
      title={`Make ${name} an admin?`}
      description="Admins see every account, collab and payout, and can suspend people and move money. The grant is written to the audit log."
      confirmLabel="Grant admin"
      success="They are an admin now."
    />
  )
}

export function RevokeAdminButton({ userId, name }: { userId: string; name: string }) {
  return (
    <ConfirmButton
      run={() => revokeAdminAction({ userId })}
      label="Revoke admin"
      icon={<ShieldMinus aria-hidden="true" />}
      title={`Remove ${name}'s admin role?`}
      description="They keep their creator or builder account and lose access to the admin area."
      confirmLabel="Revoke admin"
      confirmVariant="destructive"
      success="The admin role is removed."
    />
  )
}

export function VerifyConnectionButton({ connectionId }: { connectionId: string }) {
  return (
    <ActionButton
      run={() => verifySocialConnection({ connectionId })}
      label="Verify"
      icon={<BadgeCheck aria-hidden="true" />}
      success="Marked as verified."
      variant="outline"
    />
  )
}

/** "View as": a reason (kept in the audit log), then the app opens as them, read-only. */
export function ViewAsButton({ userId, name }: { userId: string; name: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(
    async (_previous: Result, formData: FormData): Promise<Result> =>
      startImpersonationAction({ userId, reason: String(formData.get("reason") ?? "") }),
    null,
  )
  const reasonError = state && !state.ok ? state.fieldErrors?.reason?.[0] : undefined
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className={fullOnPhone}>
          <Eye aria-hidden="true" />
          View as
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>View the app as {name}?</DialogTitle>
          <DialogDescription>
            You&apos;ll see exactly what they see, for up to an hour. Nothing can be changed while
            you look: every save is turned off. The start and the end are written to the audit log.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${id}-reason`}>Why do you need to look?</Label>
            <Textarea
              id={`${id}-reason`}
              name="reason"
              required
              maxLength={IMPERSONATION_REASON_MAX}
              rows={3}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? `${id}-reason-error` : undefined}
              placeholder="Support request: payouts page shows an error"
            />
            {reasonError ? (
              <p id={`${id}-reason-error`} className="text-sm text-destructive">
                {reasonError}
              </p>
            ) : null}
          </div>
          {!reasonError ? <ErrorText state={state} /> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" className="h-11 sm:h-9">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending} className="h-11 sm:h-9">
              <Spinner pending={pending} icon={<Eye aria-hidden="true" />} />
              Start viewing
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
