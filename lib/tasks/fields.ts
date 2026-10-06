import { z } from "zod"

/**
 * Collab tasks (§5 `tasks`, CLAUDE.md §19.24 "Tasks"): the form's fields and the date rules.
 * Client-safe: the task form and the server actions share them.
 */

export const TASK_TITLE_MAX = 200
export const TASK_DESCRIPTION_MAX = 2000

export const TASK_MESSAGES = {
  titleMissing: "Give the task a title.",
  titleTooLong: `Keep the title under ${TASK_TITLE_MAX} characters.`,
  descriptionTooLong: `Keep the notes under ${TASK_DESCRIPTION_MAX.toLocaleString("en")} characters.`,
  dueDateInvalid: "Pick a valid date, or leave it empty.",
  assigneeInvalid: "Pick someone in this collab, or nobody.",
} as const

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar day "YYYY-MM-DD" between 2000 and 2100 (what `<input type="date">` sends). */
export function isValidDueDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return false
  const year = date.getUTCFullYear()
  return date.toISOString().slice(0, 10) === value && year >= 2000 && year <= 2100
}

const emptyToNull = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "")
    ? null
    : value

/** CRLF from browsers' textareas counts as one character, like the counter shows. */
const normalizeText = (value: unknown) =>
  typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : value

export const taskFields = {
  title: z.preprocess(
    normalizeText,
    z
      .string({ error: TASK_MESSAGES.titleMissing })
      .min(1, TASK_MESSAGES.titleMissing)
      .max(TASK_TITLE_MAX, TASK_MESSAGES.titleTooLong)
      .transform((value) => value.replace(/\s+/g, " ")),
  ),
  description: z.preprocess(
    (value) => emptyToNull(normalizeText(value)),
    z.string().max(TASK_DESCRIPTION_MAX, TASK_MESSAGES.descriptionTooLong).nullable(),
  ),
  assigneeUserId: z.preprocess(
    emptyToNull,
    z.uuid({ error: TASK_MESSAGES.assigneeInvalid }).nullable(),
  ),
  dueDate: z.preprocess(
    emptyToNull,
    z.string().refine(isValidDueDate, { error: TASK_MESSAGES.dueDateInvalid }).nullable(),
  ),
}

export const taskFieldsSchema = z.object(taskFields)
export type TaskFields = z.output<typeof taskFieldsSchema>

/** The UTC calendar day of an instant, "YYYY-MM-DD". */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * `task.completed.on_time` (CLAUDE.md §19.24): done on or before the due day (UTC); null without a
 * due date.
 */
export function completedOnTime(dueDate: string | null, completedAt: Date): boolean | null {
  if (!dueDate) return null
  return utcDay(completedAt) <= dueDate
}

/** An open task whose due day is before today (UTC). */
export function isOverdue(dueDate: string | null, at: Date): boolean {
  return dueDate !== null && dueDate < utcDay(at)
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/** "5 Oct", or "5 Oct 2027" outside the current year (UTC). */
export function formatDueDate(dueDate: string, at: Date): string {
  const [year, month, day] = dueDate.split("-").map(Number)
  const label = `${day} ${SHORT_MONTHS[(month ?? 1) - 1]}`
  return year === at.getUTCFullYear() ? label : `${label} ${year}`
}
