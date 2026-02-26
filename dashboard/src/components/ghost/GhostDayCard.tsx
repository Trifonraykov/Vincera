"use client";

import { motion } from "framer-motion";
import { cardEntrance } from "@/lib/animations";
import { cn } from "@/lib/utils";
import type { GhostReport, Json } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// JSONB safety helpers
// ---------------------------------------------------------------------------

type JsonObj = Record<string, Json>;

function asArr(val: Json | null | undefined): Json[] {
  return Array.isArray(val) ? val : [];
}

function asObj(val: Json | null | undefined): JsonObj | null {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return val as JsonObj;
  }
  return null;
}

function asStr(val: Json | null | undefined): string {
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return "";
}

function asNum(val: Json | null | undefined): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface GhostDayCardProps {
  report: GhostReport;
  dayNumber: number;
  isToday: boolean;
}

// ---------------------------------------------------------------------------
// Confidence color
// ---------------------------------------------------------------------------

function confidenceColor(c: number): string {
  if (c >= 0.8) return "text-accent";
  if (c >= 0.5) return "text-warning";
  return "text-error";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GhostDayCard({
  report,
  dayNumber,
  isToday,
}: GhostDayCardProps) {
  const processes = asArr(report.observed_processes);
  const automations = asArr(report.would_have_automated);
  const observations = asArr(report.key_observations);

  const dateStr = new Date(report.report_date).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const hasContent =
    processes.length > 0 || automations.length > 0 || observations.length > 0;

  return (
    <motion.div
      variants={cardEntrance}
      className={cn(
        "rounded-lg border bg-bg-surface p-5",
        isToday
          ? "border-l-[3px] border-l-accent border-t-border-primary border-r-border-primary border-b-border-primary bg-accent/[0.02]"
          : "border-border-primary"
      )}
    >
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">{"\uD83D\uDC7B"}</span>
          <span className="font-heading text-lg text-text-primary">
            Day {dayNumber}
          </span>
          <span className="font-mono text-xs text-text-muted">{dateStr}</span>
          {isToday && (
            <span className="rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[10px] text-accent">
              Today
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-text-secondary">
            {report.estimated_hours_saved}h saved
          </span>
          <span className="font-mono text-xs text-text-secondary">
            {report.estimated_tasks_automated} tasks
          </span>
        </div>
      </div>

      {!hasContent && (
        <p className="font-body text-sm text-text-muted italic">
          No detailed observations for this day.
        </p>
      )}

      {/* Observed Processes */}
      {processes.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
            Observed Processes
          </p>
          <div className="space-y-1.5 border-l-2 border-border-primary pl-3">
            {processes.map((p, i) => {
              const obj = asObj(p);
              if (obj) {
                const name = asStr(obj.name) || asStr(obj.description) || `Process ${i + 1}`;
                const freq = asStr(obj.frequency);
                const time = asStr(obj.time_spent);
                return (
                  <p
                    key={i}
                    className="font-body text-sm text-text-secondary"
                  >
                    <span className="mr-1 text-text-muted">&middot;</span>
                    {name}
                    {(freq || time) && (
                      <span className="ml-2 font-mono text-xs text-text-muted">
                        {[freq, time].filter(Boolean).join(", ")}
                      </span>
                    )}
                  </p>
                );
              }
              const str = asStr(p);
              if (str) {
                return (
                  <p
                    key={i}
                    className="font-body text-sm text-text-secondary"
                  >
                    <span className="mr-1 text-text-muted">&middot;</span>
                    {str}
                  </p>
                );
              }
              return null;
            })}
          </div>
        </div>
      )}

      {/* Would Have Automated */}
      {automations.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
            Would Have Automated
          </p>
          <div className="space-y-2.5 border-l-2 border-accent/30 pl-3">
            {automations.map((a, i) => {
              const obj = asObj(a);
              if (obj) {
                const task =
                  asStr(obj.task) ||
                  asStr(obj.name) ||
                  `Task ${i + 1}`;
                const hours = asNum(obj.estimated_hours_saved);
                const confidence = asNum(obj.confidence);
                const approach = asStr(obj.approach);
                return (
                  <div key={i}>
                    <p className="font-body text-sm text-text-primary">
                      <span className="mr-1 text-accent">&#9656;</span>
                      {task}
                      {(hours > 0 || confidence > 0) && (
                        <span className="ml-2 font-mono text-xs">
                          {hours > 0 && (
                            <span className="text-accent">
                              est. {hours}h saved
                            </span>
                          )}
                          {hours > 0 && confidence > 0 && (
                            <span className="text-text-muted"> &middot; </span>
                          )}
                          {confidence > 0 && (
                            <span className={confidenceColor(confidence)}>
                              {Math.round(confidence * 100)}% confident
                            </span>
                          )}
                        </span>
                      )}
                    </p>
                    {approach && (
                      <p className="mt-0.5 pl-4 font-body text-xs text-text-muted">
                        {approach}
                      </p>
                    )}
                  </div>
                );
              }
              const str = asStr(a);
              if (str) {
                return (
                  <p
                    key={i}
                    className="font-body text-sm text-text-primary"
                  >
                    <span className="mr-1 text-accent">&#9656;</span>
                    {str}
                  </p>
                );
              }
              return null;
            })}
          </div>
        </div>
      )}

      {/* Key Observations */}
      {observations.length > 0 && (
        <div>
          <p className="mb-2 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
            Key Observations
          </p>
          <ul className="space-y-1 pl-3">
            {observations.map((obs, i) => {
              const str = asStr(obs) || (asObj(obs) ? asStr(asObj(obs)!.text || asObj(obs)!.observation) : "");
              if (!str) return null;
              return (
                <li
                  key={i}
                  className="font-body text-xs text-text-muted italic"
                >
                  &bull; {str}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </motion.div>
  );
}
