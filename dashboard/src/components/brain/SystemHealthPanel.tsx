"use client";

import { motion } from "framer-motion";
import { dissolveIn } from "@/lib/animations";
import { cn } from "@/lib/utils";
import type { Json } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SystemHealthPanelProps {
  systemHealth: Json | null;
  lastDiff: Json | null;
  activeAgents: Json | null;
}

// ---------------------------------------------------------------------------
// Safe JSONB access
// ---------------------------------------------------------------------------

type JsonObj = Record<string, Json>;

function asObj(val: Json | null | undefined): JsonObj | null {
  if (val && typeof val === "object" && !Array.isArray(val)) return val as JsonObj;
  return null;
}

function asArr(val: Json | null | undefined): Json[] {
  if (Array.isArray(val)) return val;
  return [];
}

function asStr(val: Json | null | undefined): string {
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return "";
}

function asNum(val: Json | null | undefined): number {
  if (typeof val === "number") return val;
  return 0;
}

// ---------------------------------------------------------------------------
// Gauge bar
// ---------------------------------------------------------------------------

function GaugeBar({ value, max, label, unit }: { value: number; max: number; label: string; unit: string }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const color =
    pct >= 90
      ? "bg-error"
      : pct >= 75
        ? "bg-warning"
        : "bg-accent";

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-[10px] text-text-muted">{label}</span>
        <span className="font-mono text-[10px] text-text-secondary">
          {value.toFixed(1)}{unit}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-bg-primary">
        <div
          className={cn("h-full rounded-full transition-all", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SystemHealthPanel({
  systemHealth,
  lastDiff,
  activeAgents,
}: SystemHealthPanelProps) {
  const health = asObj(systemHealth);
  const diff = asObj(lastDiff);
  const agents = asArr(activeAgents);

  if (!health && !diff && agents.length === 0) {
    return (
      <div className="rounded-lg border border-border-primary bg-bg-surface p-4">
        <h3 className="mb-3 font-heading text-lg text-text-primary">
          System Health
        </h3>
        <p className="font-body text-xs text-text-muted italic">
          No observer data yet. The orchestrator will populate this once it starts scanning.
        </p>
      </div>
    );
  }

  const severity = diff ? asStr(diff.severity) : "normal";
  const totalChanges = diff ? asNum(diff.total_changes) : 0;

  return (
    <motion.div
      variants={dissolveIn}
      initial="hidden"
      animate="visible"
      className="rounded-lg border border-border-primary bg-bg-surface p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-heading text-lg text-text-primary">
          System Health
        </h3>
        {severity !== "normal" && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-mono text-[10px] uppercase",
              severity === "alert"
                ? "bg-error/20 text-error"
                : "bg-warning/20 text-warning"
            )}
          >
            {severity}
          </span>
        )}
      </div>

      <div className="space-y-3">
        {/* Resource gauges */}
        {health && (
          <div className="space-y-2">
            <GaugeBar
              value={asNum(health.cpu_percent)}
              max={100}
              label="CPU"
              unit="%"
            />
            <GaugeBar
              value={asNum(health.memory_used_percent)}
              max={100}
              label="Memory"
              unit="%"
            />
          </div>
        )}

        {/* Stats grid */}
        {health && (
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md bg-bg-primary px-2.5 py-1.5 text-center">
              <p className="font-mono text-lg text-text-primary">
                {asNum(health.process_count)}
              </p>
              <p className="font-mono text-[9px] text-text-muted">Processes</p>
            </div>
            <div className="rounded-md bg-bg-primary px-2.5 py-1.5 text-center">
              <p className="font-mono text-lg text-text-primary">
                {asNum(health.database_count)}
              </p>
              <p className="font-mono text-[9px] text-text-muted">Databases</p>
            </div>
          </div>
        )}

        {/* Diff summary */}
        {diff && totalChanges > 0 && (
          <div className="rounded-md bg-bg-primary px-3 py-2">
            <p className="mb-1 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
              Last Diff
            </p>
            <p className="font-mono text-xs text-text-secondary">
              {totalChanges} change{totalChanges !== 1 ? "s" : ""} detected
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {asArr(diff.new_processes).length > 0 && (
                <span className="font-mono text-[9px] text-accent">
                  +{asArr(diff.new_processes).length} proc
                </span>
              )}
              {asArr(diff.stopped_processes).length > 0 && (
                <span className="font-mono text-[9px] text-error">
                  -{asArr(diff.stopped_processes).length} proc
                </span>
              )}
              {asArr(diff.new_files).length > 0 && (
                <span className="font-mono text-[9px] text-accent">
                  +{asArr(diff.new_files).length} files
                </span>
              )}
              {asArr(diff.modified_files).length > 0 && (
                <span className="font-mono text-[9px] text-warning">
                  ~{asArr(diff.modified_files).length} files
                </span>
              )}
              {asArr(diff.log_anomalies).length > 0 && (
                <span className="font-mono text-[9px] text-error">
                  {asArr(diff.log_anomalies).length} log errors
                </span>
              )}
            </div>
          </div>
        )}

        {/* Active agents */}
        {agents.length > 0 && (
          <div>
            <p className="mb-1.5 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
              Active Agents
            </p>
            <div className="space-y-1">
              {agents.map((a, i) => {
                const ao = asObj(a);
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-md bg-bg-primary px-2.5 py-1.5"
                  >
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                    <span className="font-mono text-[10px] text-accent">
                      {asStr(ao?.agent_name)}
                    </span>
                    <span className="font-body text-[10px] text-text-muted">
                      {asStr(ao?.task_name)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Last observed timestamp */}
        {health?.last_observed && (
          <p className="font-mono text-[9px] text-text-muted">
            Last scan: {new Date(asStr(health.last_observed)).toLocaleTimeString()}
          </p>
        )}
      </div>
    </motion.div>
  );
}
