"use client"

import { FileText, Loader2, Paperclip, SendHorizontal, X } from "lucide-react"
import { useActionState, useId, useRef, useState, type KeyboardEvent } from "react"
import { toast } from "sonner"

import { FormErrorAlert } from "@/components/profiles/form-kit"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { ActionResult } from "@/lib/actions/result"
import { postMessageAction, requestAttachmentUploadAction } from "@/lib/messages/actions"
import {
  ATTACHMENT_ACCEPT,
  attachmentTypeOf,
  checkAttachment,
  displayFilename,
  MESSAGE_ATTACHMENTS_MAX,
  MESSAGE_BODY_MAX,
} from "@/lib/messages/fields"
import { formatBytes } from "@/lib/storage/limits"

type PendingFile = {
  id: string
  name: string
  size: number
  state: "uploading" | "ready" | "failed"
  key?: string
}

/**
 * The message box under a thread: Markdown text (Ctrl/⌘ + Enter sends), and up to five files that
 * upload straight to storage through signed URLs while the person types (§14: 25 MB, allow-listed
 * types, checked here first and again on the server). Sending submits the text with the uploads'
 * keys; a refused send keeps the text and the files.
 */
export function MessageComposer({ threadId }: { threadId: string }) {
  const id = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<PendingFile[]>([])
  const [body, setBody] = useState("")
  const nextId = useRef(0)
  const [result, formAction, pending] = useActionState(
    async (_previous: ActionResult<{ messageId: string }> | null, formData: FormData) => {
      const sent = await postMessageAction(formData)
      if (sent.ok) {
        setBody("")
        setFiles([])
        return sent
      }
      // The server deletes a send's uploads whatever the outcome (§19.19 pattern), so files that
      // went with a refused send must be attached again.
      const attached = String(formData.get("attachments") ?? "[]")
      if (attached !== "[]") {
        toast.error("Your message wasn't sent. Attach your files again, then send.")
        setFiles((current) => current.filter((file) => file.state === "uploading"))
      }
      return sent
    },
    null,
  )
  const failed = result && !result.ok ? result : null
  const fieldError = (name: string) => failed?.fieldErrors?.[name]?.[0]

  async function upload(file: File) {
    const entry: PendingFile = {
      id: `file-${(nextId.current += 1)}`,
      name: displayFilename(file.name),
      size: file.size,
      state: "uploading",
    }
    const contentType = attachmentTypeOf(file)
    const check = checkAttachment({ contentType, sizeBytes: file.size })
    if (!check.ok) {
      toast.error(`${entry.name}: ${check.message}`)
      return
    }
    setFiles((current) => [...current, entry])
    const update = (patch: Partial<PendingFile>) =>
      setFiles((current) => current.map((f) => (f.id === entry.id ? { ...f, ...patch } : f)))
    try {
      const signed = await requestAttachmentUploadAction({
        threadId,
        contentType: check.contentType,
        sizeBytes: file.size,
      })
      if (!signed.ok) throw new Error(signed.error)
      const response = await fetch(signed.data.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": signed.data.contentType },
        body: file,
      })
      if (!response.ok) throw new Error("upload failed")
      update({ state: "ready", key: signed.data.key })
    } catch (failure) {
      update({ state: "failed" })
      toast.error(
        failure instanceof Error && failure.message !== "upload failed"
          ? failure.message
          : `${entry.name} didn't upload. Check your connection and try again.`,
      )
    }
  }

  function onPick(list: FileList | null) {
    const picked = Array.from(list ?? [])
    const room = MESSAGE_ATTACHMENTS_MAX - files.length
    if (picked.length > room) {
      toast.error(`You can attach up to ${MESSAGE_ATTACHMENTS_MAX} files to a message.`)
    }
    for (const file of picked.slice(0, Math.max(0, room))) void upload(file)
    if (fileRef.current) fileRef.current.value = ""
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      formRef.current?.requestSubmit()
    }
  }

  const uploading = files.some((file) => file.state === "uploading")
  const ready = files.filter((file) => file.state === "ready" && file.key)
  const bodyError = fieldError("body")
  const attachmentsError = fieldError("attachments")

  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      className="space-y-2 rounded-xl border bg-card p-3 shadow-xs"
    >
      <input type="hidden" name="threadId" value={threadId} />
      <input
        type="hidden"
        name="attachments"
        value={JSON.stringify(ready.map((file) => ({ key: file.key, filename: file.name })))}
      />
      {failed && !bodyError && !attachmentsError ? <FormErrorAlert message={failed.error} /> : null}
      <label htmlFor={`${id}-body`} className="sr-only">
        Message
      </label>
      <Textarea
        id={`${id}-body`}
        name="body"
        rows={2}
        maxLength={MESSAGE_BODY_MAX}
        placeholder="Write a message…"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        aria-invalid={bodyError ? true : undefined}
        aria-describedby={`${id}-hint${bodyError ? ` ${id}-error` : ""}`}
        className="max-h-60 min-h-11 resize-none border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      {bodyError || attachmentsError ? (
        <p id={`${id}-error`} className="px-1 text-sm text-destructive">
          {bodyError ?? attachmentsError}
        </p>
      ) : null}
      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Attachments">
          {files.map((file) => (
            <li
              key={file.id}
              className="flex max-w-full items-center gap-2 rounded-lg border bg-background py-1 pr-1 pl-2 text-xs"
            >
              {file.state === "uploading" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <FileText
                  className={file.state === "failed" ? "size-3.5 text-destructive" : "size-3.5"}
                  aria-hidden="true"
                />
              )}
              <span className="max-w-48 truncate">{file.name}</span>
              <span className="text-muted-foreground">
                {file.state === "failed" ? "failed" : formatBytes(file.size)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles((current) => current.filter((f) => f.id !== file.id))}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <input
            ref={fileRef}
            id={`${id}-files`}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            tabIndex={-1}
            aria-hidden="true"
            data-attach-input=""
            className="sr-only"
            onChange={(event) => onPick(event.target.files)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 md:size-9"
            aria-label="Attach files"
            disabled={files.length >= MESSAGE_ATTACHMENTS_MAX}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip aria-hidden="true" />
          </Button>
          <p id={`${id}-hint`} className="hidden text-xs text-muted-foreground sm:block">
            Markdown works. Up to {MESSAGE_ATTACHMENTS_MAX} files, 25 MB each.
          </p>
        </div>
        <Button
          type="submit"
          disabled={pending || uploading || body.trim() === ""}
          className="h-11 md:h-9"
        >
          {pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <SendHorizontal aria-hidden="true" />
          )}
          Send
        </Button>
      </div>
    </form>
  )
}
