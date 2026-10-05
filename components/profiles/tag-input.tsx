"use client"

import { X } from "lucide-react"
import { useState, type ChangeEvent, type KeyboardEvent } from "react"

import { cn } from "@/lib/utils"

import { addTags, cleanTag, splitTyped, submittedTags } from "./tag-list"

/**
 * A tag input for short lists (creator topics, builder skills and stack): type a tag and press
 * Enter or a comma; Backspace in the empty box removes the last one; each chip has its own remove
 * button. The form receives one hidden field `name` holding the tags, plus any text still being
 * typed, as a comma list, so the server parses exactly what the old comma field sent (and pasting
 * "a, b, c" works). Duplicates are dropped ignoring case. The server validates the limits again.
 *
 * Remount with a `key` when the saved list changes (after a settings save) to show the stored
 * spelling.
 */
export function TagInput({
  id,
  name,
  label,
  defaultValue,
  max,
  normalize = (tag) => tag,
  placeholder,
  describedBy,
  invalid = false,
}: {
  id: string
  name: string
  /** What one tag is called, for the remove buttons and announcements, e.g. "skill". */
  label: string
  defaultValue: readonly string[]
  max: number
  /** Applied to each new tag before it is added (e.g. lowercase topics). */
  normalize?: (tag: string) => string
  placeholder?: string
  describedBy?: string
  invalid?: boolean
}) {
  const [tags, setTags] = useState<string[]>(() => [...defaultValue])
  const [draft, setDraft] = useState("")
  const [announcement, setAnnouncement] = useState("")

  const full = tags.length >= max
  const pending = cleanTag(draft, normalize)
  const submitted = submittedTags(tags, draft, normalize)

  /** Add finished tags; returns the ones that did not fit (over `max`). */
  function add(values: string[]): string[] {
    const result = addTags(tags, values, { max, normalize })
    if (result.added.length > 0) {
      setTags(result.tags)
      setAnnouncement(`Added ${result.added.join(", ")}.`)
    }
    return result.overflow
  }

  function remove(index: number): void {
    const tag = tags[index]
    setTags(tags.filter((_, position) => position !== index))
    if (tag) setAnnouncement(`Removed ${tag}.`)
  }

  function onChange(event: ChangeEvent<HTMLInputElement>): void {
    const { finished, draft: rest } = splitTyped(event.target.value)
    const overflow = finished.length > 0 ? add(finished) : []
    // Tags that did not fit stay in the box (and are submitted, so the server explains the limit).
    setDraft(overflow.length > 0 ? [...overflow, rest].filter(Boolean).join(", ") : rest)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter" && pending) {
      // Enter adds the tag; with an empty box it submits the form as usual.
      event.preventDefault()
      if (add([draft]).length === 0) setDraft("")
    } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
      event.preventDefault()
      remove(tags.length - 1)
    }
  }

  function onBlur(): void {
    if (pending && add([draft]).length === 0) setDraft("")
  }

  return (
    <div>
      <input type="hidden" name={name} value={submitted} />
      <div
        className={cn(
          "flex min-h-11 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 shadow-xs transition-[color,box-shadow] md:min-h-9 dark:bg-input/30",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          invalid && "border-destructive ring-destructive/20 dark:ring-destructive/40",
        )}
      >
        {tags.length > 0 ? (
          <ul className="flex max-w-full flex-wrap gap-1.5" aria-label={`Added ${label}s`}>
            {tags.map((tag, index) => (
              <li
                key={tag}
                className="inline-flex max-w-full items-center gap-1 rounded-md bg-secondary py-0.5 pr-0.5 pl-2 text-sm text-secondary-foreground"
              >
                <span className="truncate">{tag}</span>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Remove ${label} ${tag}`}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          id={id}
          type="text"
          value={draft}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          placeholder={full ? `That's the most you can add` : tags.length === 0 ? placeholder : ""}
          readOnly={full && draft === ""}
          enterKeyHint="enter"
          autoComplete="off"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className="h-8 min-w-32 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
