"use client"

import { PencilLine, X } from "lucide-react"
import { useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"

import { AudienceSummaryForm } from "./audience-summary-form"

/** Read view of the summary with an "Edit" toggle that swaps in the form (/app/audience). */
export function SummaryEditor({
  summary,
  topics,
  children,
}: {
  summary: string | null
  topics: readonly string[]
  /** The read-only rendering, shown while not editing. */
  children: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  return (
    <div className="space-y-4">
      {editing ? (
        <AudienceSummaryForm
          mode="edit"
          summary={summary}
          topics={topics}
          onSaved={() => setEditing(false)}
        />
      ) : (
        children
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setEditing((value) => !value)}
        aria-expanded={editing}
      >
        {editing ? <X aria-hidden="true" /> : <PencilLine aria-hidden="true" />}
        {editing ? "Cancel editing" : "Edit summary and topics"}
      </Button>
    </div>
  )
}
