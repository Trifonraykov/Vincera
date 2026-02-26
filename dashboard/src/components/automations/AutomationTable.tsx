"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  ChevronUp,
  Pause,
  Play,
  Undo2,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { cardEntrance, staggerChildren } from "@/lib/animations";
import { cn, timeAgo, formatNumber } from "@/lib/utils";
import type { Automation, Json } from "@/lib/supabase";
import ConfirmModal from "@/components/ui/ConfirmModal";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHoursSaved(a: Automation): number {
  const meta = a.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const obj = meta as Record<string, Json>;
    if (typeof obj.hours_saved_total === "number") return obj.hours_saved_total;
    if (typeof obj.hours_saved === "number") return obj.hours_saved;
  }
  return 0;
}

function successRate(a: Automation): number | null {
  if (a.run_count === 0) return null;
  return (a.success_count / a.run_count) * 100;
}

const STATUS_PRIORITY: Record<string, number> = {
  failed: 0,
  active: 1,
  canary: 2,
  shadow: 3,
  paused: 4,
  retired: 5,
};

function statusDot(status: string) {
  switch (status) {
    case "active":
      return { dot: "bg-accent", text: "text-accent", label: "active" };
    case "shadow":
      return { dot: "border border-[#4488FF] bg-transparent", text: "text-[#4488FF]", label: "shadow" };
    case "canary":
      return { dot: "bg-accent/50", text: "text-accent/80", label: "canary" };
    case "paused":
      return { dot: "bg-warning", text: "text-warning", label: "paused" };
    case "failed":
      return { dot: "bg-error", text: "text-error", label: "failed" };
    case "retired":
      return { dot: "bg-text-muted/40", text: "text-text-muted", label: "retired" };
    default:
      return { dot: "bg-text-muted/40", text: "text-text-muted", label: status };
  }
}

const NEXT_STAGE: Record<string, string> = {
  shadow: "canary",
  canary: "active",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AutomationTableProps {
  automations: Automation[];
  filter: string;
  onUpdateStatus: (id: string, status: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------

function ActionButtons({
  automation,
  onPromote,
  onPause,
  onResume,
  onRollback,
  onRetry,
  onDelete,
}: {
  automation: Automation;
  onPromote?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onRollback?: () => void;
  onRetry?: () => void;
  onDelete?: () => void;
}) {
  const s = automation.status;

  return (
    <div
      className="flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
    >
      {(s === "shadow" || s === "canary") && onPromote && (
        <button
          onClick={onPromote}
          title={`Promote to ${NEXT_STAGE[s]}`}
          className="rounded p-1 text-accent transition-colors hover:bg-accent/10"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
      )}
      {s === "active" && onPause && (
        <button
          onClick={onPause}
          title="Pause"
          className="rounded p-1 text-warning transition-colors hover:bg-warning/10"
        >
          <Pause className="h-3.5 w-3.5" />
        </button>
      )}
      {s === "paused" && onResume && (
        <button
          onClick={onResume}
          title="Resume"
          className="rounded p-1 text-warning transition-colors hover:bg-warning/10"
        >
          <Play className="h-3.5 w-3.5" />
        </button>
      )}
      {(s === "canary" || s === "active") && onRollback && (
        <button
          onClick={onRollback}
          title="Rollback"
          className="rounded p-1 text-text-secondary transition-colors hover:bg-bg-surface-raised"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
      )}
      {s === "failed" && onRetry && (
        <button
          onClick={onRetry}
          title="Retry"
          className="rounded p-1 text-accent transition-colors hover:bg-accent/10"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      )}
      {(s === "shadow" || s === "paused" || s === "failed") && onDelete && (
        <button
          onClick={onDelete}
          title="Delete"
          className="rounded p-1 text-error transition-colors hover:bg-error/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Success rate mini bar
// ---------------------------------------------------------------------------

function SuccessBar({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-text-muted">&mdash;</span>;
  const color =
    rate >= 90 ? "bg-accent" : rate >= 70 ? "bg-warning" : "bg-error";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-12 rounded-full bg-bg-primary">
        <div
          className={cn("h-full rounded-full", color)}
          style={{ width: `${Math.min(rate, 100)}%` }}
        />
      </div>
      <span className="font-mono text-xs text-text-secondary">
        {rate.toFixed(1)}%
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AutomationTable({
  automations,
  filter,
  onUpdateStatus,
  onDelete,
}: AutomationTableProps) {
  const router = useRouter();
  const [confirmAction, setConfirmAction] = useState<{
    id: string;
    title: string;
    description: string;
    action: () => Promise<void>;
    variant: "accent" | "danger";
    label: string;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Filter
  const filtered =
    filter === "all"
      ? automations.filter((a) => a.status !== "retired")
      : automations.filter((a) => a.status === filter);

  // Sort: status priority then updated_at desc
  const sorted = [...filtered].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 99;
    const pb = STATUS_PRIORITY[b.status] ?? 99;
    if (pa !== pb) return pa - pb;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  function handlePromote(a: Automation) {
    const next = NEXT_STAGE[a.status];
    if (!next) return;
    setConfirmAction({
      id: a.id,
      title: `Promote to ${next}?`,
      description: `"${a.name}" will be promoted from ${a.status} to ${next}.`,
      action: () => onUpdateStatus(a.id, next),
      variant: "accent",
      label: `Promote to ${next}`,
    });
  }

  function handleDelete(a: Automation) {
    setConfirmAction({
      id: a.id,
      title: "Delete automation?",
      description: `"${a.name}" will be permanently deleted. This cannot be undone.`,
      action: () => onDelete(a.id),
      variant: "danger",
      label: "Delete",
    });
  }

  async function runConfirm() {
    if (!confirmAction) return;
    setActionLoading(true);
    await confirmAction.action();
    setActionLoading(false);
    setConfirmAction(null);
  }

  // Empty state
  if (sorted.length === 0) {
    const msg =
      filter === "all"
        ? "No automations yet. The system is still observing your workflows."
        : `No ${filter} automations.`;
    return (
      <p className="py-12 text-center font-body text-sm text-text-muted italic">
        {msg}
      </p>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden lg:block">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border-primary">
              {["Name", "Status", "Schedule", "Last Run", "Success", "Hours Saved", ""].map(
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
            {sorted.map((a) => {
              const sd = statusDot(a.status);
              const rate = successRate(a);
              const hours = getHoursSaved(a);

              return (
                <tr
                  key={a.id}
                  onClick={() => router.push(`/dashboard/automations/${a.id}`)}
                  className="cursor-pointer border-b border-border-primary/50 transition-colors hover:bg-bg-surface-raised/50"
                >
                  <td className="px-3 py-3">
                    <span
                      className={cn(
                        "font-body text-sm font-medium text-text-primary",
                        a.status === "retired" && "line-through text-text-muted"
                      )}
                    >
                      {a.name}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "inline-block h-2 w-2 shrink-0 rounded-full",
                          sd.dot
                        )}
                      />
                      <span className={cn("font-body text-xs", sd.text)}>
                        {sd.label}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-text-muted">
                    {a.schedule ?? "\u2014"}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-text-muted">
                    {a.last_run ? timeAgo(a.last_run) : "\u2014"}
                  </td>
                  <td className="px-3 py-3">
                    <SuccessBar rate={rate} />
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-text-secondary">
                    {hours > 0 ? formatNumber(hours) : "\u2014"}
                  </td>
                  <td className="px-3 py-3">
                    <ActionButtons
                      automation={a}
                      onPromote={() => handlePromote(a)}
                      onPause={() => onUpdateStatus(a.id, "paused")}
                      onResume={() => onUpdateStatus(a.id, "active")}
                      onRollback={() =>
                        onUpdateStatus(
                          a.id,
                          a.status === "active" ? "canary" : "shadow"
                        )
                      }
                      onRetry={() => onUpdateStatus(a.id, "active")}
                      onDelete={() => handleDelete(a)}
                    />
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
        {sorted.map((a) => {
          const sd = statusDot(a.status);
          const rate = successRate(a);
          const hours = getHoursSaved(a);

          return (
            <motion.div
              key={a.id}
              variants={cardEntrance}
              onClick={() => router.push(`/dashboard/automations/${a.id}`)}
              className="cursor-pointer rounded-lg border border-border-primary bg-bg-surface p-4 transition-colors hover:bg-bg-surface-raised/50"
            >
              <div className="mb-2 flex items-center justify-between">
                <span
                  className={cn(
                    "font-body text-sm font-medium text-text-primary",
                    a.status === "retired" && "line-through text-text-muted"
                  )}
                >
                  {a.name}
                </span>
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-block h-2 w-2 rounded-full",
                      sd.dot
                    )}
                  />
                  <span className={cn("font-body text-xs", sd.text)}>
                    {sd.label}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <SuccessBar rate={rate} />
                {hours > 0 && (
                  <span className="font-mono text-xs text-text-muted">
                    {formatNumber(hours)}h
                  </span>
                )}
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="font-mono text-[10px] text-text-muted">
                  {a.last_run ? timeAgo(a.last_run) : "No runs"}
                </span>
                <ActionButtons
                  automation={a}
                  onPromote={() => handlePromote(a)}
                  onPause={() => onUpdateStatus(a.id, "paused")}
                  onResume={() => onUpdateStatus(a.id, "active")}
                  onRollback={() =>
                    onUpdateStatus(
                      a.id,
                      a.status === "active" ? "canary" : "shadow"
                    )
                  }
                  onRetry={() => onUpdateStatus(a.id, "active")}
                  onDelete={() => handleDelete(a)}
                />
              </div>
            </motion.div>
          );
        })}
      </motion.div>

      {/* Confirmation modal */}
      <ConfirmModal
        isOpen={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        onConfirm={runConfirm}
        title={confirmAction?.title ?? ""}
        description={confirmAction?.description ?? ""}
        confirmLabel={confirmAction?.label}
        confirmVariant={confirmAction?.variant}
        isLoading={actionLoading}
      />
    </>
  );
}
