"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { pageTransition } from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import { useAutomations } from "@/hooks/useAutomations";
import { cn } from "@/lib/utils";
import AutomationTable from "@/components/automations/AutomationTable";

// ---------------------------------------------------------------------------
// Filter tabs
// ---------------------------------------------------------------------------

const FILTERS = [
  { key: "all", label: "All" },
  { key: "shadow", label: "Shadow" },
  { key: "canary", label: "Canary" },
  { key: "active", label: "Active" },
  { key: "paused", label: "Paused" },
  { key: "failed", label: "Failed" },
] as const;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AutomationsPage() {
  const { companyId } = useDashboard();
  const { automations, isLoading, updateStatus, deleteAutomation } =
    useAutomations(companyId);
  const [filter, setFilter] = useState("all");

  // Counts per status
  const counts: Record<string, number> = {};
  for (const a of automations) {
    counts[a.status] = (counts[a.status] ?? 0) + 1;
  }
  const total = automations.filter((a) => a.status !== "retired").length;

  // Summary text
  const summaryParts: string[] = [`${total} automations`];
  if (counts.active) summaryParts.push(`${counts.active} active`);
  if (counts.shadow) summaryParts.push(`${counts.shadow} shadow`);
  if (counts.canary) summaryParts.push(`${counts.canary} canary`);

  return (
    <motion.div
      variants={pageTransition}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {/* Header */}
      <div className="mb-6">
        <h1 className="font-heading text-3xl font-semibold text-text-primary">
          Automations
        </h1>
        <p className="mt-1 font-body text-sm text-text-secondary">
          {summaryParts.join(" \u00B7 ")}
        </p>
      </div>

      {/* Filter tabs */}
      <div className="mb-4 flex flex-wrap gap-1">
        {FILTERS.map((f) => {
          const count =
            f.key === "all"
              ? total
              : counts[f.key] ?? 0;
          const isActive = filter === f.key;
          const isFailed = f.key === "failed" && count > 0;

          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1.5 font-body text-xs transition-colors",
                isActive
                  ? "bg-bg-surface-raised text-text-primary"
                  : "text-text-secondary hover:text-text-primary"
              )}
            >
              {f.label}
              <span
                className={cn(
                  "font-mono text-[10px]",
                  isActive
                    ? "text-text-primary"
                    : isFailed
                      ? "text-error"
                      : "text-text-muted"
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex h-40 items-center justify-center">
          <span className="font-mono text-sm text-text-muted">Loading...</span>
        </div>
      )}

      {/* Table */}
      {!isLoading && (
        <AutomationTable
          automations={automations}
          filter={filter}
          onUpdateStatus={updateStatus}
          onDelete={deleteAutomation}
        />
      )}
    </motion.div>
  );
}
