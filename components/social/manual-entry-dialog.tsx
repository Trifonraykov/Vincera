"use client"

import { CircleAlert, Loader2, PencilLine } from "lucide-react"
import { useRouter } from "next/navigation"
import { useId, useState, useTransition, type FormEvent } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { FieldErrors } from "@/lib/actions/result"
import { requestEvidenceUpload, submitManualConnection } from "@/lib/social/actions"
import { SOCIAL_PROVIDER_META } from "@/lib/social/catalog"
import {
  checkEvidenceFile,
  checkManualEntryFields,
  EVIDENCE_POLICY,
  PROFILE_URL_EXAMPLES,
} from "@/lib/social/manual-policy"
import type { CreatorSocialProviderId } from "@/lib/social/types"
import { formatBytes } from "@/lib/storage/limits"

/**
 * "Enter manually" (§7.1 fallback): follower count, profile link and a screenshot of the count.
 * Every field is checked here first (the same rules as the server), so nothing is uploaded for a
 * form that would be refused. Then the screenshot goes straight to storage through a signed PUT
 * URL, and the form is submitted with the stored object's key. The entry shows as "Unverified"
 * until an admin checks it.
 */
export function ManualEntryDialog({
  provider,
  update = false,
  triggerVariant = "outline",
}: {
  provider: CreatorSocialProviderId
  /** Re-entering numbers for an existing manual entry. */
  update?: boolean
  triggerVariant?: "default" | "outline" | "ghost" | "secondary"
}) {
  const label = SOCIAL_PROVIDER_META[provider].label
  const router = useRouter()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  const fields = {
    profileUrl: `${id}-profile-url`,
    followers: `${id}-followers`,
    screenshot: `${id}-screenshot`,
  }
  const errorOf = (name: string) => fieldErrors[name]?.[0]

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const file = form.get("screenshot")
    const profileUrl = String(form.get("profileUrl") ?? "")
    const followers = String(form.get("followers") ?? "")
    setError(null)
    setFieldErrors({})

    const errors: FieldErrors = {}
    const fieldsCheck = checkManualEntryFields(provider, { followers, profileUrl })
    if (!fieldsCheck.ok) Object.assign(errors, fieldsCheck.fieldErrors)
    const check =
      file instanceof File && file.size > 0
        ? checkEvidenceFile({ contentType: file.type, sizeBytes: file.size })
        : ({ ok: false, message: "Choose a screenshot of your follower count." } as const)
    if (!check.ok) errors.screenshot = [check.message]
    if (!check.ok || !fieldsCheck.ok || !(file instanceof File)) {
      setFieldErrors(errors)
      focusFirstInvalid(event.currentTarget, errors)
      return
    }

    startTransition(async () => {
      const upload = await requestEvidenceUpload({
        provider,
        contentType: check.contentType,
        sizeBytes: file.size,
      })
      if (!upload.ok) {
        setError(upload.error)
        return
      }
      let uploaded = false
      try {
        const response = await fetch(upload.data.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": upload.data.contentType },
          body: file,
        })
        uploaded = response.ok
      } catch {
        uploaded = false
      }
      if (!uploaded) {
        setError("Your screenshot didn't upload. Check your connection and try again.")
        return
      }
      const result = await submitManualConnection({
        provider,
        followers,
        profileUrl,
        evidenceKey: upload.data.key,
      })
      if (!result.ok) {
        setError(result.fieldErrors ? null : result.error)
        setFieldErrors(result.fieldErrors ?? {})
        return
      }
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size="sm" className="w-full sm:w-auto">
          <PencilLine aria-hidden="true" />
          {update ? "Update numbers" : "Enter manually"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enter your {label} numbers</DialogTitle>
          <DialogDescription>
            Until you can connect {label}, add your follower count with a screenshot that shows it.
            Your profile shows these numbers as unverified until our team checks the screenshot.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor={fields.profileUrl}>Link to your {label} profile</Label>
            <Input
              id={fields.profileUrl}
              name="profileUrl"
              type="url"
              inputMode="url"
              autoComplete="url"
              required
              placeholder={PROFILE_URL_EXAMPLES[provider]}
              aria-invalid={errorOf("profileUrl") ? true : undefined}
              aria-describedby={errorOf("profileUrl") ? `${fields.profileUrl}-error` : undefined}
            />
            {errorOf("profileUrl") ? (
              <p id={`${fields.profileUrl}-error`} className="text-sm text-destructive">
                {errorOf("profileUrl")}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor={fields.followers}>
              {provider === "youtube" ? "Subscribers" : "Followers"}
            </Label>
            <Input
              id={fields.followers}
              name="followers"
              inputMode="numeric"
              autoComplete="off"
              required
              placeholder="12,500"
              aria-invalid={errorOf("followers") ? true : undefined}
              aria-describedby={errorOf("followers") ? `${fields.followers}-error` : undefined}
            />
            {errorOf("followers") ? (
              <p id={`${fields.followers}-error`} className="text-sm text-destructive">
                {errorOf("followers")}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor={fields.screenshot}>Screenshot showing the count</Label>
            <Input
              id={fields.screenshot}
              name="screenshot"
              type="file"
              required
              accept={EVIDENCE_POLICY.mimeTypes.join(",")}
              aria-invalid={(errorOf("screenshot") ?? errorOf("evidenceKey")) ? true : undefined}
              aria-describedby={`${fields.screenshot}-hint${
                (errorOf("screenshot") ?? errorOf("evidenceKey"))
                  ? ` ${fields.screenshot}-error`
                  : ""
              }`}
            />
            <p id={`${fields.screenshot}-hint`} className="text-sm text-muted-foreground">
              PNG, JPEG, WebP or GIF, up to {formatBytes(EVIDENCE_POLICY.maxBytes)}. Only our team
              sees it.
            </p>
            {(errorOf("screenshot") ?? errorOf("evidenceKey")) ? (
              <p id={`${fields.screenshot}-error`} className="text-sm text-destructive">
                {errorOf("screenshot") ?? errorOf("evidenceKey")}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {pending ? "Saving…" : "Save numbers"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Move focus to the first field with an error, so keyboard and screen reader users land on it. */
function focusFirstInvalid(form: HTMLFormElement, errors: FieldErrors): void {
  for (const name of ["profileUrl", "followers", "screenshot"]) {
    if (!errors[name]?.length) continue
    const field = form.elements.namedItem(name)
    if (field instanceof HTMLElement) field.focus()
    return
  }
}
