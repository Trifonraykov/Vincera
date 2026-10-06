import { describe, expect, it } from "vitest"

import { collabNextStep, matchesCollabFilter, parseCollabFilter } from "@/lib/collabs/display"
import {
  completedOnTime,
  formatDueDate,
  isOverdue,
  isValidDueDate,
  TASK_MESSAGES,
  taskFieldsSchema,
} from "@/lib/tasks/fields"

/** Task fields and dates, and the collab list's filters and next steps (CLAUDE.md §19.28). */

const NOW = new Date("2026-10-05T12:00:00Z")
const MEMBER = "0190a000-0000-7000-8000-000000000001"

describe("task fields", () => {
  it("parses the form: trimmed title, empty optional fields as null", () => {
    expect(
      taskFieldsSchema.parse({
        title: "  Sketch   the screens \r\n",
        description: "  ",
        assigneeUserId: "",
        dueDate: "",
      }),
    ).toEqual({
      title: "Sketch the screens",
      description: null,
      assigneeUserId: null,
      dueDate: null,
    })
    expect(
      taskFieldsSchema.parse({
        title: "T",
        description: "a\r\nb",
        assigneeUserId: MEMBER,
        dueDate: "2026-10-31",
      }),
    ).toEqual({ title: "T", description: "a\nb", assigneeUserId: MEMBER, dueDate: "2026-10-31" })
  })

  it("explains what is wrong in plain language", () => {
    const result = taskFieldsSchema.safeParse({
      title: "",
      description: "x".repeat(2001),
      assigneeUserId: "someone",
      dueDate: "2026-02-30",
    })
    const messages = result.error?.issues.map((issue) => issue.message)
    expect(messages).toEqual(
      expect.arrayContaining([
        TASK_MESSAGES.titleMissing,
        TASK_MESSAGES.descriptionTooLong,
        TASK_MESSAGES.assigneeInvalid,
        TASK_MESSAGES.dueDateInvalid,
      ]),
    )
  })

  it("accepts real calendar days only", () => {
    expect(isValidDueDate("2028-02-29")).toBe(true)
    expect(isValidDueDate("2027-02-29")).toBe(false)
    expect(isValidDueDate("2026-13-01")).toBe(false)
    expect(isValidDueDate("1999-12-31")).toBe(false)
    expect(isValidDueDate("5/10/2026")).toBe(false)
  })

  it("decides on time by the UTC day, and overdue after it", () => {
    expect(completedOnTime(null, NOW)).toBeNull()
    expect(completedOnTime("2026-10-05", new Date("2026-10-05T23:59:59Z"))).toBe(true)
    expect(completedOnTime("2026-10-05", new Date("2026-10-06T00:00:00Z"))).toBe(false)
    expect(isOverdue("2026-10-04", NOW)).toBe(true)
    expect(isOverdue("2026-10-05", NOW)).toBe(false)
    expect(isOverdue(null, NOW)).toBe(false)
  })

  it("shows due days briefly", () => {
    expect(formatDueDate("2026-10-09", NOW)).toBe("9 Oct")
    expect(formatDueDate("2027-01-02", NOW)).toBe("2 Jan 2027")
  })
})

describe("collab filters and next steps", () => {
  it("defaults to active collabs", () => {
    expect(parseCollabFilter(undefined)).toBe("active")
    expect(parseCollabFilter("building")).toBe("building")
    expect(parseCollabFilter("nope")).toBe("active")
    expect(matchesCollabFilter("ended", "active")).toBe(false)
    expect(matchesCollabFilter("ended", "all")).toBe(true)
    expect(matchesCollabFilter("live", "live")).toBe(true)
  })

  it("asks for the viewer's signature first", () => {
    const base = { agreementStatus: "awaiting_signatures" as const, openTasks: 0 }
    expect(collabNextStep({ ...base, stage: "agreement", signedByViewer: false })).toEqual({
      text: "Sign the agreement",
      needsViewer: true,
    })
    expect(collabNextStep({ ...base, stage: "agreement", signedByViewer: true })).toEqual({
      text: "Waiting for your collaborator to sign",
      needsViewer: false,
    })
    expect(
      collabNextStep({
        stage: "building",
        agreementStatus: "signed",
        signedByViewer: true,
        openTasks: 3,
      }),
    ).toEqual({ text: "3 open tasks", needsViewer: false })
  })
})
