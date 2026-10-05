"use client"

import { CircleAlert } from "lucide-react"
import { useActionState, type ComponentProps, type ReactNode } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Label } from "@/components/ui/label"
import type { ActionResult, FieldErrors } from "@/lib/actions/result"
import { cn } from "@/lib/utils"

/**
 * Small building blocks for the profile and settings forms: a server-action hook that remembers
 * what was submitted, a labelled field with hint and error wired to `aria-describedby`, a native
 * select styled like `Input`, and the form-level error alert.
 */

export type SubmittedValues = Record<string, string | string[]>

function valuesOf(formData: FormData): SubmittedValues {
  const values: SubmittedValues = {}
  for (const key of new Set(formData.keys())) {
    const all = formData.getAll(key).filter((value): value is string => typeof value === "string")
    values[key] = all.length === 1 ? (all[0] ?? "") : all
  }
  return values
}

export type FormActionState<T> = { result: ActionResult<T>; values: SubmittedValues } | null

/**
 * `useActionState` for a `defineAction` server action. React resets uncontrolled fields after a
 * form action; when the action fails, `valueOf` gives back what the person typed, so fields keep
 * it. After a success the fields show the saved data the page re-rendered with.
 */
export function useFormAction<T>(action: (formData: FormData) => Promise<ActionResult<T>>) {
  const [state, formAction, pending] = useActionState(
    async (_previous: FormActionState<T>, formData: FormData) => ({
      result: await action(formData),
      values: valuesOf(formData),
    }),
    null,
  )
  const failed = state !== null && !state.result.ok ? state : null
  const error = failed && !failed.result.ok ? failed.result : null

  function valueOf(name: string, fallback: string): string {
    const value = failed?.values[name]
    return typeof value === "string" ? value : fallback
  }

  function valuesFor(name: string, fallback: readonly string[]): string[] {
    if (!failed) return [...fallback]
    const value = failed.values[name]
    if (value === undefined) return []
    return Array.isArray(value) ? value : [value]
  }

  function fieldError(name: string): string | undefined {
    return error?.fieldErrors?.[name]?.[0]
  }

  return {
    formAction,
    pending,
    /** The last result (success or failure), or null before the first submit. */
    result: state?.result ?? null,
    error,
    fieldError,
    /** True when the form error has no field to sit next to. */
    hasFormError: (fields: readonly string[]) =>
      error !== null && !fields.some((field) => fieldErrorIn(error.fieldErrors, field)),
    valueOf,
    valuesFor,
  }
}

function fieldErrorIn(errors: FieldErrors | undefined, field: string): boolean {
  return (errors?.[field]?.length ?? 0) > 0
}

/** `aria-describedby` / `aria-invalid` for an input with an optional hint and error. */
export function describe(id: string, { hint, error }: { hint?: boolean; error?: string }) {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean)
  return {
    "aria-describedby": ids.length > 0 ? ids.join(" ") : undefined,
    "aria-invalid": error ? true : undefined,
  } as const
}

/** A labelled form field: label, control, hint and error message. */
export function Field({
  id,
  label,
  optional = false,
  hint,
  error,
  children,
  className,
}: {
  id: string
  label: ReactNode
  optional?: boolean
  hint?: ReactNode
  error?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={id}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground">(optional)</span> : null}
      </Label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** A native `<select>` (works with FormData and on every phone) styled like `Input`. */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none md:text-sm dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  )
}

/** The form-level error (a failure without a field to sit next to). */
export function FormErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

/** A radio card: a native radio inside a label, like the role picker. */
export function RadioCard({
  name,
  value,
  title,
  description,
  defaultChecked,
  required,
  describedBy,
}: {
  name: string
  value: string
  title: string
  description: string
  defaultChecked: boolean
  required?: boolean
  describedBy?: string
}) {
  return (
    <label className="relative flex cursor-pointer flex-col gap-1 rounded-lg border bg-card p-4 text-sm shadow-xs transition-colors hover:bg-accent/50 has-[:checked]:border-primary has-[:checked]:ring-2 has-[:checked]:ring-primary/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        required={required}
        aria-describedby={describedBy}
        className="sr-only"
      />
      <span className="font-medium">{title}</span>
      <span className="text-muted-foreground">{description}</span>
    </label>
  )
}
