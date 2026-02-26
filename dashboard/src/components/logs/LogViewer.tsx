"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Download, ChevronRight, ChevronDown } from "lucide-react";
import { slideInRight } from "@/lib/animations";
import { cn } from "@/lib/utils";
import { useLogs } from "@/hooks/useLogs";
import type { Event, Json } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENTS = [
  "orchestrator",
  "discovery",
  "research",
  "builder",
  "operator",
  "analyst",
  "unstuck",
  "trainer",
  "system",
];

const EVENT_TYPES = [
  "agent_started",
  "agent_completed",
  "agent_failed",
  "automation_deployed",
  "automation_promoted",
  "automation_failed",
  "decision_created",
  "decision_approved",
  "decision_rejected",
  "system_paused",
  "system_resumed",
  "ghost_report",
  "ghost_mode_ended",
  "discovery_complete",
  "knowledge_edited",
  "company_disconnected",
  "error",
  "warning",
];

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

function severityBorder(sev: string): string {
  switch (sev) {
    case "error":
      return "border-l-error";
    case "warning":
      return "border-l-warning";
    default:
      return "border-l-text-secondary";
  }
}

function severityDot(sev: string): string {
  switch (sev) {
    case "error":
      return "bg-error";
    case "warning":
      return "bg-warning";
    default:
      return "bg-text-muted";
  }
}

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ---------------------------------------------------------------------------
// JSON syntax coloring
// ---------------------------------------------------------------------------

function JsonDisplay({ data }: { data: Json }) {
  if (!data || (typeof data === "object" && Object.keys(data).length === 0)) {
    return (
      <span className="font-mono text-xs text-text-muted italic">
        No metadata
      </span>
    );
  }
  const str = JSON.stringify(data, null, 2);
  // Simple syntax highlighting via regex
  const colored = str
    .replace(
      /"([^"]+)"(?=\s*:)/g,
      '<span class="text-text-secondary">"$1"</span>'
    )
    .replace(
      /:\s*"([^"]*)"/g,
      ': <span class="text-accent/60">"$1"</span>'
    )
    .replace(
      /:\s*(\d+\.?\d*)/g,
      ': <span class="text-text-primary">$1</span>'
    )
    .replace(
      /:\s*(true|false)/g,
      ': <span class="text-warning">$1</span>'
    )
    .replace(/:\s*(null)/g, ': <span class="text-text-muted">$1</span>');

  return (
    <pre
      className="overflow-x-auto whitespace-pre font-mono text-xs text-text-muted"
      dangerouslySetInnerHTML={{ __html: colored }}
    />
  );
}

// ---------------------------------------------------------------------------
// Log Row
// ---------------------------------------------------------------------------

function LogRow({
  event,
  isNew,
}: {
  event: Event;
  isNew: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const wrapper = isNew ? (
    <motion.div
      variants={slideInRight}
      initial="hidden"
      animate="visible"
    >
      <RowContent event={event} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
    </motion.div>
  ) : (
    <RowContent event={event} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
  );

  return wrapper;
}

function RowContent({
  event,
  expanded,
  onToggle,
}: {
  event: Event;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "border-l-[3px] transition-colors",
        severityBorder(event.severity)
      )}
    >
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-bg-surface-raised/50"
      >
        {/* Timestamp */}
        <span className="w-[80px] shrink-0 font-mono text-[11px] text-text-muted">
          {formatTimestamp(event.created_at)}
        </span>

        {/* Severity dot */}
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
            severityDot(event.severity)
          )}
        />

        {/* Agent */}
        <span className="w-[90px] shrink-0 truncate font-mono text-[11px] text-text-secondary">
          {event.agent_name ?? "system"}
        </span>

        {/* Message */}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-secondary">
          {event.message}
        </span>

        {/* Expand chevron */}
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-text-muted" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-text-muted" />
        )}
      </button>

      {/* Expanded metadata */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-border-primary/50 bg-bg-surface px-4 py-3 pl-[108px]">
              <div className="mb-1 flex items-center gap-3">
                <span className="font-mono text-[10px] text-text-muted">
                  type: {event.event_type}
                </span>
                <span className="font-mono text-[10px] text-text-muted">
                  severity: {event.severity}
                </span>
              </div>
              <JsonDisplay data={event.metadata} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface LogViewerProps {
  companyId: string;
  companyName: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LogViewer({ companyId, companyName }: LogViewerProps) {
  const { events, isLoading, hasMore, loadMore, filters, setFilters, exportCSV } =
    useLogs(companyId);

  const [newEventIds, setNewEventIds] = useState<Set<string>>(new Set());
  const initialLoadRef = useRef(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Mark realtime events as "new" for animation
  useEffect(() => {
    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      return;
    }
    if (events.length > 0) {
      const firstId = events[0].id;
      setNewEventIds((prev) => {
        const next = new Set(prev);
        next.add(firstId);
        return next;
      });
      // Clear "new" flag after animation
      setTimeout(() => {
        setNewEventIds((prev) => {
          const next = new Set(prev);
          next.delete(firstId);
          return next;
        });
      }, 1000);
    }
  }, [events]);

  // Intersection observer for infinite scroll
  useEffect(() => {
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoading) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, isLoading, loadMore]);

  // Debounced search
  const handleSearch = useCallback(
    (value: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setFilters({ search: value });
      }, 300);
    },
    [setFilters]
  );

  return (
    <div>
      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border-primary bg-bg-surface p-4">
        {/* Agent */}
        <select
          value={filters.agent ?? ""}
          onChange={(e) =>
            setFilters({ agent: e.target.value || null })
          }
          className="rounded-md border border-border-primary bg-bg-primary px-2 py-1.5 font-mono text-xs text-text-secondary focus:outline-none"
        >
          <option value="">All agents</option>
          {AGENTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>

        {/* Event type */}
        <select
          value={filters.eventType ?? ""}
          onChange={(e) =>
            setFilters({ eventType: e.target.value || null })
          }
          className="rounded-md border border-border-primary bg-bg-primary px-2 py-1.5 font-mono text-xs text-text-secondary focus:outline-none"
        >
          <option value="">All types</option>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        {/* Severity */}
        <div className="flex gap-1">
          {[
            { key: null, label: "All" },
            { key: "info", label: "Info" },
            { key: "warning", label: "\u26A0 Warning" },
            { key: "error", label: "\u2717 Error" },
          ].map((s) => (
            <button
              key={s.label}
              onClick={() => setFilters({ severity: s.key })}
              className={cn(
                "rounded-md px-2 py-1 font-mono text-[11px] transition-colors",
                filters.severity === s.key
                  ? s.key === "error"
                    ? "bg-error/10 text-error"
                    : s.key === "warning"
                      ? "bg-warning/10 text-warning"
                      : "bg-bg-surface-raised text-text-primary"
                  : "text-text-muted hover:text-text-secondary"
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Date range */}
        <input
          type="date"
          value={filters.dateFrom ?? ""}
          onChange={(e) =>
            setFilters({ dateFrom: e.target.value || null })
          }
          className="rounded-md border border-border-primary bg-bg-primary px-2 py-1 font-mono text-xs text-text-secondary focus:outline-none"
        />
        <span className="font-mono text-xs text-text-muted">&rarr;</span>
        <input
          type="date"
          value={filters.dateTo ?? ""}
          onChange={(e) =>
            setFilters({ dateTo: e.target.value || null })
          }
          className="rounded-md border border-border-primary bg-bg-primary px-2 py-1 font-mono text-xs text-text-secondary focus:outline-none"
        />

        {/* Search */}
        <input
          type="text"
          defaultValue={filters.search}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search events..."
          className="ml-auto rounded-md border border-border-primary bg-bg-primary px-3 py-1.5 font-mono text-xs text-text-primary placeholder:text-text-muted focus:border-accent/50 focus:outline-none"
        />

        {/* Export */}
        <button
          onClick={() => exportCSV(companyName)}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 font-body text-xs text-text-secondary transition-colors hover:text-text-primary"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex h-40 items-center justify-center">
          <span className="font-mono text-sm text-text-muted">
            Loading events...
          </span>
        </div>
      )}

      {/* Log entries */}
      {!isLoading && events.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border-primary bg-bg-surface">
          {events.map((event) => (
            <LogRow
              key={event.id}
              event={event}
              isNew={newEventIds.has(event.id)}
            />
          ))}

          {/* Sentinel for infinite scroll */}
          {hasMore && (
            <div ref={sentinelRef} className="px-4 py-3 text-center">
              <button
                onClick={loadMore}
                className="font-mono text-xs text-text-muted transition-colors hover:text-text-secondary"
              >
                Load more events...
              </button>
            </div>
          )}
        </div>
      )}

      {/* Empty */}
      {!isLoading && events.length === 0 && (
        <p className="py-12 text-center font-mono text-sm text-text-muted italic">
          No events logged yet. Events will appear as agents begin working.
        </p>
      )}
    </div>
  );
}
