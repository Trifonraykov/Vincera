"use client";

import { cn } from "@/lib/utils";
import type { Company } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CompanyHeaderProps {
  company: Company | null;
  agentCount: number;
  automationCount: number;
  totalHoursSaved: number;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function statusDisplay(status: string) {
  switch (status) {
    case "active":
      return { dot: "bg-accent", label: "Active", color: "text-accent" };
    case "ghost":
      return { dot: "bg-text-muted", label: "\uD83D\uDC7B Ghost Mode", color: "text-text-muted" };
    case "paused":
      return { dot: "bg-warning", label: "Paused", color: "text-warning" };
    case "discovering":
      return { dot: "bg-accent animate-pulse", label: "Discovering...", color: "text-accent" };
    case "disconnected":
      return { dot: "bg-error", label: "Disconnected", color: "text-error" };
    default:
      return { dot: "bg-text-muted", label: status, color: "text-text-muted" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CompanyHeader({
  company,
  agentCount,
  automationCount,
  totalHoursSaved,
}: CompanyHeaderProps) {
  if (!company) {
    return (
      <div className="rounded-t-lg border border-border-primary bg-bg-surface p-6">
        <span className="font-mono text-sm text-text-muted">Loading company...</span>
      </div>
    );
  }

  const sd = statusDisplay(company.status);

  const connectedDate = new Date(company.created_at).toLocaleDateString(
    "en-US",
    { month: "short", day: "numeric", year: "numeric" }
  );

  return (
    <div className="rounded-t-lg border border-border-primary bg-bg-surface p-6">
      {/* Row 1: Name + Status */}
      <div className="flex items-start justify-between">
        <h1 className="font-heading text-4xl font-semibold text-text-primary">
          {company.name}
        </h1>
        <div className="flex items-center gap-2">
          <span
            className={cn("inline-block h-2 w-2 rounded-full", sd.dot)}
          />
          <span className={cn("font-body text-sm font-medium", sd.color)}>
            {sd.label}
          </span>
        </div>
      </div>

      {/* Row 2: Industry + Type */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {company.business_type && (
          <span className="rounded-full bg-bg-surface-raised px-2.5 py-0.5 font-body text-xs text-text-secondary">
            {company.business_type}
          </span>
        )}
        {company.industry && (
          <span className="rounded-full bg-bg-surface-raised px-2.5 py-0.5 font-body text-xs text-text-secondary">
            {company.industry}
          </span>
        )}
        <span className="font-mono text-xs text-text-muted">
          Connected: {connectedDate}
        </span>
      </div>

      {/* Row 3: Stats */}
      <div className="mt-3 flex items-center gap-1 font-body text-sm text-text-secondary">
        <span className="font-mono text-text-primary">{agentCount}</span>{" "}
        agents &middot;{" "}
        <span className="font-mono text-text-primary">{automationCount}</span>{" "}
        automations &middot;{" "}
        <span className="font-mono text-text-primary">
          {Math.round(totalHoursSaved * 10) / 10}
        </span>{" "}
        hrs saved
      </div>
    </div>
  );
}
