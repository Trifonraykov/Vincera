"use client"

import { Check, Loader2, X } from "lucide-react"
import { useEffect, useRef, useState, type ChangeEvent } from "react"

import { Input } from "@/components/ui/input"
import { checkHandleAvailabilityAction } from "@/lib/profiles/actions"
import {
  handleSchema,
  normalizeHandle,
  RESERVED_HANDLES,
  type HandleAvailability,
} from "@/lib/profiles/fields"
import { HANDLE_MAX_LENGTH } from "@/lib/profiles/handle-format"
import { cn } from "@/lib/utils"

import { Field } from "./form-kit"

/** How long typing must pause before the handle is checked with the server. */
const CHECK_DELAY_MS = 400

type LiveStatus =
  { state: "checking"; handle: string } | { state: "done"; result: HandleAvailability }

/**
 * The handle input shared by both profile forms: `@` prefix, the public URL it gives, a note when
 * the user's other profile already uses a handle, and a live check as the person types (format and
 * reserved words at once, then availability from the server after a short pause). The check is a
 * hint: saving claims the handle and has the final word.
 */
export function HandleField({
  id,
  defaultValue,
  error,
  publicPathPrefix,
  sharedNote,
}: {
  id: string
  defaultValue: string
  error?: string
  /** "/c/" or "/b/". */
  publicPathPrefix: "/c/" | "/b/"
  sharedNote?: string
}) {
  const [status, setStatus] = useState<LiveStatus | null>(null)
  const [preview, setPreview] = useState(normalizeHandle(defaultValue))
  // A new submit result (another `error`, or the saved handle) replaces the live answer.
  const [basis, setBasis] = useState({ error, defaultValue })
  if (basis.error !== error || basis.defaultValue !== defaultValue) {
    setBasis({ error, defaultValue })
    setStatus(null)
    setPreview(normalizeHandle(defaultValue))
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(0)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  function onChange(event: ChangeEvent<HTMLInputElement>): void {
    const raw = event.target.value
    const handle = normalizeHandle(raw)
    const request = ++latest.current
    if (timer.current) clearTimeout(timer.current)
    setPreview(handle)

    // Back to exactly what was loaded: nothing to say.
    if (raw === defaultValue && !error) {
      setStatus(null)
      return
    }
    const local = handleSchema.safeParse(raw)
    if (!local.success) {
      setStatus({
        state: "done",
        result: {
          handle,
          status: RESERVED_HANDLES.has(handle) ? "reserved" : "invalid",
          message: local.error.issues[0]?.message ?? "Choose another handle.",
        },
      })
      return
    }
    setStatus({ state: "checking", handle: local.data })
    timer.current = setTimeout(async () => {
      const result = await checkHandleAvailabilityAction({ handle: raw }).catch(() => null)
      if (request !== latest.current) return
      // No answer (offline, rate-limited): show nothing; saving checks anyway.
      setStatus(result?.ok ? { state: "done", result: result.data } : null)
    }, CHECK_DELAY_MS)
  }

  const shownError = status ? undefined : error
  const bad =
    status?.state === "done" && ["taken", "reserved", "invalid"].includes(status.result.status)
  const describedBy = [`${id}-hint`, `${id}-status`, shownError ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ")

  return (
    <Field
      id={id}
      label="Handle"
      hint={
        <>
          Your public page will be at {publicPathPrefix}
          <span className="font-medium break-all text-foreground">{preview || "your_handle"}</span>.
          Lowercase letters, numbers and underscores.{sharedNote ? ` ${sharedNote}` : ""}
        </>
      }
      error={shownError}
    >
      <div className="relative">
        <span
          className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground"
          aria-hidden="true"
        >
          @
        </span>
        <Input
          id={id}
          name="handle"
          defaultValue={defaultValue}
          onChange={onChange}
          required
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
          maxLength={HANDLE_MAX_LENGTH + 1}
          className="pl-7"
          aria-describedby={describedBy}
          aria-invalid={shownError || bad ? true : undefined}
        />
      </div>
      <p
        id={`${id}-status`}
        aria-live="polite"
        className={cn(
          "flex min-h-5 items-center gap-1.5 text-sm",
          status?.state === "checking" && "text-muted-foreground",
          status?.state === "done" && !bad && "text-emerald-700 dark:text-emerald-300",
          bad && "text-destructive",
        )}
      >
        {status?.state === "checking" ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Checking @{status.handle}…
          </>
        ) : status?.state === "done" ? (
          <>
            {bad ? (
              <X className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <Check className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            {status.result.status === "available"
              ? `@${status.result.handle} is available.`
              : status.result.message}
          </>
        ) : null}
      </p>
    </Field>
  )
}
