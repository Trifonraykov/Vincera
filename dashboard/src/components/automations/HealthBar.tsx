"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { cardEntrance } from "@/lib/animations";
import { cn } from "@/lib/utils";
import type { Automation, Json } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHoursSaved(automation: Automation): number {
  const meta = automation.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const obj = meta as Record<string, Json>;
    if (typeof obj.hours_saved_total === "number") return obj.hours_saved_total;
    if (typeof obj.hours_saved === "number") return obj.hours_saved;
  }
  return 0;
}

function statusColor(status: string): string {
  switch (status) {
    case "active":
      return "bg-accent";
    case "shadow":
      return "bg-accent/20 border border-accent/50";
    case "canary":
      return "bg-accent/60";
    case "failed":
      return "bg-error";
    case "paused":
      return "bg-warning";
    case "retired":
      return "bg-text-muted/30";
    default:
      return "bg-text-muted/50";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "shadow":
      return "Shadow";
    case "canary":
      return "Canary";
    case "failed":
      return "Failed";
    case "paused":
      return "Paused";
    case "retired":
      return "Retired";
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function SegmentTooltip({
  automation,
  hours,
}: {
  automation: Automation;
  hours: number;
}) {
  return (
    <div className="pointer-events-none absolute -top-14 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-border-primary bg-bg-primary px-2.5 py-1.5 shadow-lg">
      <p className="font-body text-xs font-medium text-text-primary">
        {automation.name}
      </p>
      <p className="font-mono text-[10px] text-text-muted">
        {statusLabel(automation.status)} · {hours.toFixed(1)}h saved
      </p>
      <div className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-b border-r border-border-primary bg-bg-primary" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface HealthBarProps {
  automations: Automation[];
  isLoading: boolean;
}

export default function HealthBar({ automations, isLoading }: HealthBarProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Compute segments
  const segments = automations.map((a) => ({
    automation: a,
    hours: getHoursSaved(a),
  }));

  const totalHours = segments.reduce((sum, s) => sum + s.hours, 0);

  // If no hours data, fall back to equal sizing
  const useEqualWidth = totalHours === 0;

  return (
    <motion.div
      variants={cardEntrance}
      className="rounded-lg border border-border-primary bg-bg-surface p-4"
    >
      <h3 className="mb-3 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
        Automation Health
      </h3>

      {isLoading && (
        <div className="h-6 rounded-full bg-bg-primary" />
      )}

      {!isLoading && automations.length === 0 && (
        <p className="font-body text-xs text-text-muted italic">
          No automations deployed yet
        </p>
      )}

      {!isLoading && automations.length > 0 && (
        <>
          {/* Bar */}
          <div className="flex h-6 overflow-hidden rounded-full bg-bg-primary">
            {segments.map(({ automation, hours }) => {
              const widthPct = useEqualWidth
                ? 100 / segments.length
                : (hours / totalHours) * 100;

              return (
                <div
                  key={automation.id}
                  className="relative"
                  style={{ width: `${Math.max(widthPct, 2)}%` }}
                  onMouseEnter={() => setHoveredId(automation.id)}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  <div
                    className={cn(
                      "h-full transition-opacity hover:opacity-80",
                      statusColor(automation.status)
                    )}
                  />
                  {hoveredId === automation.id && (
                    <SegmentTooltip automation={automation} hours={hours} />
                  )}
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div className="mt-3 flex flex-wrap gap-3">
            {segments.map(({ automation }) => (
              <div key={automation.id} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "inline-block h-2 w-2 rounded-full",
                    statusColor(automation.status)
                  )}
                />
                <span className="font-mono text-[10px] text-text-muted">
                  {automation.name}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </motion.div>
  );
}
