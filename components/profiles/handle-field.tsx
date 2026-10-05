"use client"

import { Input } from "@/components/ui/input"
import { HANDLE_MAX_LENGTH } from "@/lib/profiles/handle-format"

import { describe, Field } from "./form-kit"

/**
 * The handle input shared by both profile forms: `@` prefix, the public URL it gives, and a note
 * when the user's other profile already uses a handle.
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
  return (
    <Field
      id={id}
      label="Handle"
      hint={
        <>
          Your public page will be at {publicPathPrefix}
          <span className="font-medium text-foreground">your_handle</span>. Lowercase letters,
          numbers and underscores.{sharedNote ? ` ${sharedNote}` : ""}
        </>
      }
      error={error}
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
          required
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
          maxLength={HANDLE_MAX_LENGTH + 1}
          className="pl-7"
          {...describe(id, { hint: true, error })}
        />
      </div>
    </Field>
  )
}
