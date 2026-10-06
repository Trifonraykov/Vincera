"use client"

import { FileText, ImagePlus, KeyRound, Loader2, Trash2, Upload } from "lucide-react"
import { useActionState, useId, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { ActionResult } from "@/lib/actions/result"
import {
  addLaunchFileAction,
  addLaunchMediaAction,
  addLicenseKeysAction,
  removeLaunchFileAction,
  removeLaunchMediaAction,
  removeUnassignedKeysAction,
  requestLaunchUploadAction,
} from "@/lib/launches/actions"
import {
  checkLaunchUpload,
  cleanFilename,
  DELIVERABLE_ACCEPT,
  fileTypeOf,
  LAUNCH_FILES_MAX,
  LAUNCH_MEDIA_MAX,
  MEDIA_ACCEPT,
  MEDIA_ALT_MAX,
  type UploadKind,
} from "@/lib/launches/fields"
import { formatBytes } from "@/lib/storage/limits"

/**
 * Launch content beyond the form (§12, CLAUDE.md §19.32): deliverable files, product images and
 * license keys. Files upload straight to storage through a signed URL (checked here first, then on
 * the server after a copy, §14), then "add" records them; adding or removing a file or image
 * resets approvals like a save. Keys are stock and can be added while the launch is live.
 */

async function uploadFile(
  launchId: string,
  kind: UploadKind,
  file: File,
): Promise<{ ok: true; key: string } | { ok: false; message: string }> {
  const contentType = fileTypeOf(file, kind)
  const check = checkLaunchUpload(kind, { contentType, sizeBytes: file.size })
  if (!check.ok) return { ok: false, message: check.message }
  const signed = await requestLaunchUploadAction({
    launchId,
    kind,
    contentType: check.contentType,
    sizeBytes: file.size,
  })
  if (!signed.ok) return { ok: false, message: signed.error }
  try {
    const response = await fetch(signed.data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": signed.data.contentType },
      body: file,
    })
    if (!response.ok) throw new Error("upload failed")
  } catch {
    return {
      ok: false,
      message: "The upload didn't go through. Check your connection and try again.",
    }
  }
  return { ok: true, key: signed.data.key }
}

function RemoveButton({
  label,
  onRemove,
}: {
  label: string
  onRemove: () => Promise<ActionResult<unknown>>
}) {
  const [, action, pending] = useActionState(async () => {
    const result = await onRemove()
    if (!result.ok) toast.error(result.error)
    return null
  }, null)
  return (
    <form action={action}>
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        className="size-11 md:size-9"
        aria-label={label}
        disabled={pending}
      >
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <Trash2 aria-hidden="true" />
        )}
      </Button>
    </form>
  )
}

// --- Files ----------------------------------------------------------------------------------

export type LaunchFileView = { id: string; filename: string; sizeBytes: number }

export function LaunchFiles({
  launchId,
  files,
  canEdit,
}: {
  launchId: string
  files: readonly LaunchFileView[]
  canEdit: boolean
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function onPick(list: FileList | null) {
    const picked = Array.from(list ?? [])
    if (input.current) input.current.value = ""
    for (const file of picked.slice(0, Math.max(0, LAUNCH_FILES_MAX - files.length))) {
      setBusy(cleanFilename(file.name))
      const uploaded = await uploadFile(launchId, "deliverable", file)
      if (!uploaded.ok) {
        toast.error(`${cleanFilename(file.name)}: ${uploaded.message}`)
        continue
      }
      const added = await addLaunchFileAction({
        launchId,
        uploadKey: uploaded.key,
        filename: file.name,
      })
      if (added.ok) toast.success(`Added ${cleanFilename(file.name)}.`)
      else toast.error(added.error)
    }
    setBusy(null)
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3">
      <div className="space-y-1">
        <h3 id={`${id}-heading`} className="font-medium">
          Files for buyers
        </h3>
        <p className="text-sm text-muted-foreground">
          Buyers download these after paying. Up to {LAUNCH_FILES_MAX} files, 200 MB each.
        </p>
      </div>
      {files.length > 0 ? (
        <ul className="divide-y rounded-lg border" aria-label="Files for buyers">
          {files.map((file) => (
            <li key={file.id} className="flex min-h-11 items-center gap-3 py-1 pr-1 pl-3">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm">{file.filename}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatBytes(file.sizeBytes)}
              </span>
              {canEdit ? (
                <RemoveButton
                  label={`Remove ${file.filename}`}
                  onRemove={() => removeLaunchFileAction({ launchId, fileId: file.id })}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No files yet.
        </p>
      )}
      {canEdit && files.length < LAUNCH_FILES_MAX ? (
        <div>
          <input
            ref={input}
            id={`${id}-input`}
            type="file"
            multiple
            accept={DELIVERABLE_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            data-launch-file-input=""
            onChange={(event) => void onPick(event.target.files)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            onClick={() => input.current?.click()}
            className="h-11 w-full sm:h-9 sm:w-auto"
          >
            {busy ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Upload aria-hidden="true" />
            )}
            {busy ? `Uploading ${busy}…` : "Upload files"}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

// --- Images ---------------------------------------------------------------------------------

export type LaunchMediaView = { name: string; src: string; alt: string }

export function LaunchImages({
  launchId,
  media,
  canEdit,
}: {
  launchId: string
  media: readonly LaunchMediaView[]
  canEdit: boolean
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [alt, setAlt] = useState("")
  const [busy, setBusy] = useState(false)

  async function onPick(list: FileList | null) {
    const file = list?.[0]
    if (input.current) input.current.value = ""
    if (!file) return
    setBusy(true)
    const uploaded = await uploadFile(launchId, "media", file)
    if (!uploaded.ok) {
      toast.error(uploaded.message)
      setBusy(false)
      return
    }
    const added = await addLaunchMediaAction({ launchId, uploadKey: uploaded.key, alt })
    if (added.ok) {
      toast.success("Image added.")
      setAlt("")
    } else {
      toast.error(added.error)
    }
    setBusy(false)
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3">
      <div className="space-y-1">
        <h3 id={`${id}-heading`} className="font-medium">
          Images
        </h3>
        <p className="text-sm text-muted-foreground">
          Screenshots or a cover for the product page. Up to {LAUNCH_MEDIA_MAX} images (PNG, JPEG,
          WebP or GIF, 10 MB each).
        </p>
      </div>
      {media.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Images">
          {media.map((item) => (
            <li key={item.name} className="relative overflow-hidden rounded-lg border bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element -- a redirect to a signed URL */}
              <img src={item.src} alt={item.alt} className="aspect-video w-full object-cover" />
              {canEdit ? (
                <div className="absolute top-1 right-1 rounded-md bg-background/90">
                  <RemoveButton
                    label={`Remove image: ${item.alt}`}
                    onRemove={() => removeLaunchMediaAction({ launchId, name: item.name })}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No images yet.
        </p>
      )}
      {canEdit && media.length < LAUNCH_MEDIA_MAX ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor={`${id}-alt`}>
              Describe the next image{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id={`${id}-alt`}
              value={alt}
              maxLength={MEDIA_ALT_MAX}
              onChange={(event) => setAlt(event.target.value)}
              placeholder="The weekly plan on a phone"
            />
          </div>
          <input
            ref={input}
            type="file"
            accept={MEDIA_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            data-launch-image-input=""
            onChange={(event) => void onPick(event.target.files)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => input.current?.click()}
            className="h-11 w-full sm:h-9 sm:w-auto"
          >
            {busy ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <ImagePlus aria-hidden="true" />
            )}
            Add an image
          </Button>
        </div>
      ) : null}
    </section>
  )
}

// --- License keys ---------------------------------------------------------------------------

type KeysResult = ActionResult<{ added: number; alreadyThere: number; duplicates: number }> | null

export function LicenseKeys({
  launchId,
  unassigned,
  assigned,
  canChange,
}: {
  launchId: string
  unassigned: number
  assigned: number
  canChange: boolean
}) {
  const id = useId()
  const [text, setText] = useState("")
  const [state, action, pending] = useActionState(
    async (_previous: KeysResult, formData: FormData): Promise<KeysResult> => {
      const result = await addLicenseKeysAction({
        launchId,
        keys: String(formData.get("keys") ?? ""),
      })
      if (result.ok) {
        setText("")
        const skipped = result.data.alreadyThere + result.data.duplicates
        toast.success(
          `Added ${result.data.added} ${result.data.added === 1 ? "key" : "keys"}${skipped > 0 ? `; ${skipped} already there or repeated` : ""}.`,
        )
      }
      return result
    },
    null,
  )
  const error = state && !state.ok ? (state.fieldErrors?.keys?.[0] ?? state.error) : undefined
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3">
      <div className="space-y-1">
        <h3 id={`${id}-heading`} className="flex items-center gap-2 font-medium">
          <KeyRound className="size-4" aria-hidden="true" />
          License keys
        </h3>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          <span className="font-medium text-foreground tabular-nums">{unassigned}</span>{" "}
          {unassigned === 1 ? "key" : "keys"} left for buyers
          {assigned > 0 ? ` · ${assigned} given out` : ""}. Each buyer gets one. You can add more at
          any time, also while it&apos;s on sale.
        </p>
      </div>
      {canChange ? (
        <>
          <form action={action} className="space-y-2" noValidate>
            <Label htmlFor={`${id}-keys`}>Add keys, one per line</Label>
            <Textarea
              id={`${id}-keys`}
              name="keys"
              rows={4}
              value={text}
              onChange={(event) => setText(event.target.value)}
              spellCheck={false}
              autoCapitalize="none"
              className="font-mono"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              placeholder={"ABCD-1234-EFGH\nIJKL-5678-MNOP"}
            />
            {error ? (
              <p id={`${id}-error`} className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="outline"
              disabled={pending || text.trim() === ""}
              className="h-11 w-full sm:h-9 sm:w-auto"
            >
              {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Add keys
            </Button>
          </form>
          {unassigned > 0 ? <RemoveKeys launchId={launchId} count={unassigned} /> : null}
        </>
      ) : null}
    </section>
  )
}

function RemoveKeys({ launchId, count }: { launchId: string; count: number }) {
  const [, action, pending] = useActionState(async () => {
    if (!window.confirm(`Remove the ${count} keys nobody has bought yet?`)) return null
    const result = await removeUnassignedKeysAction({ launchId })
    if (result.ok) toast.success(`Removed ${result.data.removed} keys.`)
    else toast.error(result.error)
    return null
  }, null)
  return (
    <form action={action}>
      <Button type="submit" variant="ghost" disabled={pending} className="h-11 px-2 sm:h-9">
        <Trash2 aria-hidden="true" />
        Remove unused keys
      </Button>
    </form>
  )
}
