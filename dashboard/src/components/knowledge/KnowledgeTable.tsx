"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Check, X } from "lucide-react";
import { cardEntrance, staggerChildren } from "@/lib/animations";
import { cn, timeAgo } from "@/lib/utils";
import type { Knowledge } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface KnowledgeTableProps {
  entries: Knowledge[];
  highlightId: string | null;
  onEdit: (
    id: string,
    title: string,
    oldContent: string,
    newContent: string
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Category colors
// ---------------------------------------------------------------------------

const CATEGORY_COLORS = [
  "text-[#4488FF] bg-[#4488FF]/10",
  "text-accent bg-accent/10",
  "text-warning bg-warning/10",
  "text-[#A855F7] bg-[#A855F7]/10",
  "text-[#EC4899] bg-[#EC4899]/10",
  "text-[#14B8A6] bg-[#14B8A6]/10",
  "text-[#F97316] bg-[#F97316]/10",
  "text-text-secondary bg-bg-surface-raised",
];

function categoryColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return CATEGORY_COLORS[Math.abs(hash) % CATEGORY_COLORS.length];
}

// ---------------------------------------------------------------------------
// Relevance bar
// ---------------------------------------------------------------------------

function RelevanceBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color =
    score >= 0.8 ? "bg-accent" : score >= 0.5 ? "bg-warning" : "bg-error";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-10 rounded-full bg-bg-primary">
        <div
          className={cn("h-full rounded-full", color)}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="font-mono text-[10px] text-text-secondary">
        {score.toFixed(2)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function KnowledgeTable({
  entries,
  highlightId,
  onEdit,
}: KnowledgeTableProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [flashId, setFlashId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Scroll to highlighted row
  useEffect(() => {
    if (!highlightId) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(`knowledge-row-${highlightId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [highlightId]);

  // Focus textarea on edit
  useEffect(() => {
    if (editingId && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [editingId]);

  function startEdit(entry: Knowledge) {
    setEditingId(entry.id);
    setEditValue(entry.content);
  }

  async function saveEdit(entry: Knowledge) {
    if (editValue === entry.content) {
      setEditingId(null);
      return;
    }
    await onEdit(entry.id, entry.title, entry.content, editValue);
    setEditingId(null);
    setFlashId(entry.id);
    setTimeout(() => setFlashId(null), 1500);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue("");
  }

  if (entries.length === 0) {
    return (
      <p className="py-12 text-center font-body text-sm text-text-muted italic">
        No knowledge entries yet. The Discovery agent will populate this as it
        learns about your company.
      </p>
    );
  }

  // Sort: by category then title
  const sorted = [...entries].sort((a, b) => {
    const catCmp = a.category.localeCompare(b.category);
    if (catCmp !== 0) return catCmp;
    return a.title.localeCompare(b.title);
  });

  return (
    <>
      {/* Desktop table */}
      <div className="hidden lg:block">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border-primary">
              {["Category", "Title", "Content", "Source", "Relevance", "Updated"].map(
                (h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left font-body text-[11px] font-semibold uppercase tracking-widest text-text-muted"
                  >
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => {
              const isEditing = editingId === entry.id;
              const isHighlighted = highlightId === entry.id;
              const isFlash = flashId === entry.id;

              return (
                <tr
                  key={entry.id}
                  id={`knowledge-row-${entry.id}`}
                  className={cn(
                    "border-b border-border-primary/50 transition-colors",
                    isHighlighted && "border-l-2 border-l-accent bg-accent/[0.03]",
                    isFlash && "bg-accent/10",
                    !isHighlighted && !isFlash && "hover:bg-bg-surface-raised/50"
                  )}
                >
                  <td className="px-3 py-3">
                    <span
                      className={cn(
                        "inline-block rounded-full px-2 py-0.5 font-mono text-[10px]",
                        categoryColor(entry.category)
                      )}
                    >
                      {entry.category}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-mono text-sm text-text-primary">
                    {entry.title}
                  </td>
                  <td className="px-3 py-3">
                    {isEditing ? (
                      <div>
                        <textarea
                          ref={textareaRef}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") cancelEdit();
                            if (
                              e.key === "Enter" &&
                              (e.metaKey || e.ctrlKey)
                            ) {
                              e.preventDefault();
                              saveEdit(entry);
                            }
                          }}
                          rows={3}
                          className="w-full resize-none rounded border border-accent/50 bg-bg-primary px-2 py-1 font-body text-sm text-text-primary focus:border-accent focus:outline-none"
                        />
                        <div className="mt-1 flex items-center gap-1">
                          <button
                            onClick={() => saveEdit(entry)}
                            className="rounded bg-accent px-2 py-0.5 font-body text-[10px] font-medium text-black transition-opacity hover:opacity-90"
                          >
                            <Check className="inline h-3 w-3" /> Save
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="rounded px-2 py-0.5 font-body text-[10px] text-text-secondary transition-colors hover:text-text-primary"
                          >
                            <X className="inline h-3 w-3" /> Cancel
                          </button>
                          <span className="font-mono text-[9px] text-text-muted">
                            Ctrl+Enter to save
                          </span>
                        </div>
                      </div>
                    ) : (
                      <span
                        onClick={() => startEdit(entry)}
                        className="cursor-pointer font-body text-sm text-text-secondary transition-colors hover:text-text-primary"
                        title="Click to edit"
                      >
                        {entry.content.length > 80
                          ? entry.content.slice(0, 80) + "\u2026"
                          : entry.content}
                        {entry.source === "user" && (
                          <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent/60" title="Edited by user" />
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-text-muted">
                    {entry.source ?? "\u2014"}
                  </td>
                  <td className="px-3 py-3">
                    <RelevanceBar score={entry.relevance_score} />
                  </td>
                  <td className="px-3 py-3 font-mono text-[10px] text-text-muted">
                    {timeAgo(entry.updated_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <motion.div
        variants={staggerChildren(0.04)}
        initial="hidden"
        animate="visible"
        className="space-y-2 lg:hidden"
      >
        {sorted.map((entry) => (
          <motion.div
            key={entry.id}
            id={`knowledge-row-${entry.id}`}
            variants={cardEntrance}
            className={cn(
              "rounded-lg border border-border-primary bg-bg-surface p-4",
              highlightId === entry.id && "border-l-2 border-l-accent",
              flashId === entry.id && "bg-accent/10"
            )}
          >
            <div className="mb-2 flex items-center justify-between">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 font-mono text-[10px]",
                  categoryColor(entry.category)
                )}
              >
                {entry.category}
              </span>
              <RelevanceBar score={entry.relevance_score} />
            </div>
            <p className="font-mono text-sm text-text-primary">{entry.title}</p>
            <p className="mt-1 line-clamp-2 font-body text-xs text-text-secondary">
              {entry.content}
            </p>
            <p className="mt-2 font-mono text-[10px] text-text-muted">
              {entry.source ?? "unknown"} &middot; {timeAgo(entry.updated_at)}
            </p>
          </motion.div>
        ))}
      </motion.div>
    </>
  );
}
