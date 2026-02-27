"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  staggerChildren,
  slideInRight,
  dissolveIn,
} from "@/lib/animations";
import { cn } from "@/lib/utils";
import type { Json } from "@/lib/supabase";
import type { LtanPhase } from "@/hooks/useBrainState";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ThinkingPanelProps {
  phase: LtanPhase;
  observations: Json | null;
  analysis: Json | null;
  plannedActions: Json | null;
  actionResults: Json | null;
  systemHealth: Json | null;
  lastDiff: Json | null;
  confidence: number;
  cycleNumber: number;
  durationMs: number | null;
}

// ---------------------------------------------------------------------------
// Safe JSONB access
// ---------------------------------------------------------------------------

type JsonObj = Record<string, Json>;

function asObj(val: Json | null): JsonObj | null {
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
// Phase content components
// ---------------------------------------------------------------------------

function LookingContent({
  data,
  systemHealth,
  lastDiff,
}: {
  data: Json | null;
  systemHealth: Json | null;
  lastDiff: Json | null;
}) {
  const obj = asObj(data);
  const items = asArr(obj?.items);
  const health = asObj(systemHealth);
  const diff = asObj(lastDiff);

  return (
    <motion.div variants={dissolveIn} initial="hidden" animate="visible" className="space-y-3">
      {/* System health summary */}
      {health && (
        <div className="rounded-md bg-bg-primary px-3 py-2">
          <p className="mb-1.5 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
            System Snapshot
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span className="font-mono text-[10px] text-text-muted">CPU</span>
            <span className="font-mono text-[10px] text-text-secondary">
              {asNum(health.cpu_percent).toFixed(1)}%
            </span>
            <span className="font-mono text-[10px] text-text-muted">Memory</span>
            <span className="font-mono text-[10px] text-text-secondary">
              {asNum(health.memory_used_percent).toFixed(1)}%
            </span>
            <span className="font-mono text-[10px] text-text-muted">Processes</span>
            <span className="font-mono text-[10px] text-text-secondary">
              {asNum(health.process_count)}
            </span>
            <span className="font-mono text-[10px] text-text-muted">Databases</span>
            <span className="font-mono text-[10px] text-text-secondary">
              {asNum(health.database_count)}
            </span>
            {health.scan_duration_ms && (
              <>
                <span className="font-mono text-[10px] text-text-muted">Scan time</span>
                <span className="font-mono text-[10px] text-text-secondary">
                  {asNum(health.scan_duration_ms)}ms
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Diff summary */}
      {diff && asNum(diff.total_changes) > 0 && (
        <div className="rounded-md bg-bg-primary px-3 py-2">
          <p className="mb-1.5 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
            Changes Detected
          </p>
          <div className="flex flex-wrap gap-2">
            {asNum(diff.total_changes) > 0 && (
              <span className={cn(
                "rounded-full px-2 py-0.5 font-mono text-[10px]",
                asStr(diff.severity) === "alert"
                  ? "bg-error/20 text-error"
                  : asStr(diff.severity) === "notable"
                    ? "bg-warning/20 text-warning"
                    : "bg-accent/20 text-accent"
              )}>
                {asNum(diff.total_changes)} changes \u2022 {asStr(diff.severity) || "normal"}
              </span>
            )}
            {asArr(diff.new_processes).length > 0 && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[10px] text-accent">
                +{asArr(diff.new_processes).length} processes
              </span>
            )}
            {asArr(diff.stopped_processes).length > 0 && (
              <span className="rounded-full bg-error/10 px-2 py-0.5 font-mono text-[10px] text-error">
                -{asArr(diff.stopped_processes).length} processes
              </span>
            )}
            {asArr(diff.new_files).length > 0 && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[10px] text-accent">
                +{asArr(diff.new_files).length} files
              </span>
            )}
            {asArr(diff.modified_files).length > 0 && (
              <span className="rounded-full bg-warning/10 px-2 py-0.5 font-mono text-[10px] text-warning">
                ~{asArr(diff.modified_files).length} files modified
              </span>
            )}
            {asArr(diff.log_anomalies).length > 0 && (
              <span className="rounded-full bg-error/10 px-2 py-0.5 font-mono text-[10px] text-error">
                {asArr(diff.log_anomalies).length} log anomalies
              </span>
            )}
          </div>
        </div>
      )}

      {/* Observation items */}
      {items.length === 0 && !health && (
        <p className="font-body text-sm text-text-muted italic animate-pulse">
          Scanning system...
        </p>
      )}

      {items.length > 0 && (
        <motion.ul
          variants={staggerChildren(0.06)}
          initial="hidden"
          animate="visible"
          className="space-y-2"
        >
          {items.map((item, i) => {
            const o = asObj(item);
            const source = asStr(o?.source);
            const label = asStr(o?.label);
            const summary = asStr(o?.summary);
            const value = asStr(o?.value);
            const severity = asStr(o?.severity);
            const dotColor =
              severity === "error" || severity === "critical"
                ? "bg-error"
                : severity === "warning"
                  ? "bg-warning"
                  : "bg-accent";

            return (
              <motion.li
                key={i}
                variants={slideInRight}
                className="flex items-start gap-2"
              >
                <span
                  className={cn(
                    "mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                    dotColor
                  )}
                />
                <div>
                  {(source || label) && (
                    <span className="mr-2 font-mono text-[10px] text-text-muted">
                      {source || label}
                    </span>
                  )}
                  <span className="font-body text-sm text-text-secondary">
                    {summary || value || "\u2014"}
                  </span>
                </div>
              </motion.li>
            );
          })}
        </motion.ul>
      )}
    </motion.div>
  );
}

function ThinkingContent({ data }: { data: Json | null }) {
  const obj = asObj(data);
  const summary = asStr(obj?.summary);
  const keyFindings = asArr(obj?.key_findings);
  const concerns = asArr(obj?.concerns);
  const opportunities = asArr(obj?.opportunities);
  const risks = asArr(obj?.risks);

  if (!summary && keyFindings.length === 0 && risks.length === 0 && concerns.length === 0) {
    return (
      <p className="font-body text-sm text-text-muted italic">
        No analysis data for this phase.
      </p>
    );
  }

  return (
    <motion.div variants={dissolveIn} initial="hidden" animate="visible" className="space-y-3">
      {summary && (
        <p className="font-body text-sm leading-relaxed text-text-secondary">
          {summary}
        </p>
      )}

      {keyFindings.length > 0 && (
        <div>
          <p className="mb-1.5 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
            Key Findings
          </p>
          <ul className="space-y-1">
            {keyFindings.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span className="font-body text-sm text-text-secondary">
                  {asStr(f)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {concerns.length > 0 && (
        <div>
          <p className="mb-1.5 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
            Concerns
          </p>
          <ul className="space-y-1">
            {concerns.map((c, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                <span className="font-body text-sm text-text-secondary">
                  {asStr(c)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {opportunities.length > 0 && (
        <div>
          <p className="mb-1.5 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
            Opportunities
          </p>
          <ul className="space-y-1">
            {opportunities.map((o, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span className="font-body text-sm text-text-secondary">
                  {asStr(o)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {risks.length > 0 && (
        <div>
          <p className="mb-1.5 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
            Risks
          </p>
          <ul className="space-y-1">
            {risks.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                <span className="font-body text-sm text-text-secondary">
                  {asStr(r)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </motion.div>
  );
}

function ActingContent({ data }: { data: Json | null }) {
  const obj = asObj(data);
  const results = asArr(obj?.results);
  const actions = asArr(obj?.actions);

  // Support both planned_actions.actions and action_results.results
  const items = results.length > 0 ? results : actions;

  if (items.length === 0) {
    return (
      <p className="font-body text-sm text-text-muted italic">
        No actions or results for this phase.
      </p>
    );
  }

  const statusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return { icon: "\u2713", color: "text-accent" };
      case "running":
        return { icon: "\u25F7", color: "text-accent animate-pulse" };
      case "failed":
        return { icon: "\u2717", color: "text-error" };
      case "skipped":
        return { icon: "\u23ED", color: "text-text-muted" };
      default:
        return { icon: "\u25CB", color: "text-text-muted" };
    }
  };

  const authorityBadge = (auth: string) => {
    switch (auth) {
      case "REQUIRES_APPROVAL":
        return "bg-warning/20 text-warning";
      case "ACT_AND_NOTIFY":
        return "bg-accent/20 text-accent";
      case "ACT_SILENTLY":
        return "bg-text-muted/20 text-text-muted";
      case "PROHIBITED":
        return "bg-error/20 text-error";
      default:
        return "";
    }
  };

  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        const r = asObj(item);
        const agent = asStr(r?.agent);
        const task = asStr(r?.task);
        const status = asStr(r?.status);
        const detail = asStr(r?.detail);
        const authority = asStr(r?.authority);
        const priority = typeof r?.priority === "number" ? r.priority : null;
        const si = status ? statusIcon(status) : { icon: String(i + 1) + ".", color: "text-text-muted" };

        const prioColor =
          priority !== null && priority >= 0.8
            ? "text-accent"
            : priority !== null && priority >= 0.5
              ? "text-warning"
              : "text-text-muted";

        return (
          <div key={i} className="rounded-md bg-bg-primary px-3 py-2">
            <div className="flex items-start gap-2">
              <span className={cn("mt-0.5 font-mono text-sm", si.color)}>
                {si.icon}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-body text-sm text-text-primary">
                  <span className="font-mono text-accent">{agent}</span>
                  {task ? ` \u2014 ${task}` : ""}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {detail && (
                    <p className="font-mono text-[10px] text-text-muted">
                      {detail}
                    </p>
                  )}
                  {priority !== null && (
                    <span className={cn("font-mono text-[10px]", prioColor)}>
                      Priority: {priority.toFixed(2)}
                    </span>
                  )}
                  {authority && (
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase",
                        authorityBadge(authority)
                      )}
                    >
                      {authority.replace(/_/g, " ")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NarratingContent({
  cycleNumber,
  confidence,
  durationMs,
}: {
  cycleNumber: number;
  confidence: number;
  durationMs: number | null;
}) {
  return (
    <motion.div variants={dissolveIn} initial="hidden" animate="visible" className="space-y-3">
      <p className="font-body text-sm text-text-secondary">
        Cycle #{cycleNumber} complete. Narrating observations and updating knowledge...
      </p>

      {/* Confidence bar */}
      <div>
        <p className="mb-1 font-body text-xs text-text-muted">Confidence</p>
        <div className="h-2 w-full rounded-full bg-bg-primary">
          <motion.div
            className={cn(
              "h-full rounded-full",
              confidence >= 0.8
                ? "bg-accent"
                : confidence >= 0.5
                  ? "bg-warning"
                  : "bg-error"
            )}
            initial={{ width: 0 }}
            animate={{ width: `${Math.round(confidence * 100)}%` }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          />
        </div>
      </div>

      {durationMs !== null && (
        <p className="font-mono text-xs text-text-muted">
          Completed in {durationMs}ms
        </p>
      )}
    </motion.div>
  );
}

function IdleContent() {
  return (
    <p className="font-body text-sm text-text-muted italic">
      Waiting for trigger...
    </p>
  );
}

// ---------------------------------------------------------------------------
// Phase header labels
// ---------------------------------------------------------------------------

const PHASE_HEADERS: Record<LtanPhase, { title: string; subtitle: string }> = {
  looking: { title: "Looking", subtitle: "What I see" },
  thinking: { title: "Thinking", subtitle: "What I think" },
  acting: { title: "Acting", subtitle: "What\u2019s happening" },
  narrating: { title: "Narrating", subtitle: "What I learned" },
  idle: { title: "Idle", subtitle: "Waiting" },
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ThinkingPanel({
  phase,
  observations,
  analysis,
  plannedActions,
  actionResults,
  systemHealth,
  lastDiff,
  confidence,
  cycleNumber,
  durationMs,
}: ThinkingPanelProps) {
  const header = PHASE_HEADERS[phase] ?? PHASE_HEADERS.idle;
  const isActive = phase !== "idle";

  return (
    <div className="flex h-full flex-col rounded-lg border border-border-primary bg-bg-surface p-4">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2">
        {isActive && (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
        )}
        <h3 className="font-heading text-lg text-text-primary">
          {header.title}
        </h3>
        <span className="font-body text-xs text-text-muted">
          \u2014 {header.subtitle}
        </span>
      </div>

      {/* Scrollable content area with phase transitions */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={phase}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            {phase === "looking" && (
              <LookingContent
                data={observations}
                systemHealth={systemHealth}
                lastDiff={lastDiff}
              />
            )}
            {phase === "thinking" && <ThinkingContent data={analysis} />}
            {phase === "acting" && (
              <ActingContent data={actionResults ?? plannedActions} />
            )}
            {phase === "narrating" && (
              <NarratingContent
                cycleNumber={cycleNumber}
                confidence={confidence}
                durationMs={durationMs}
              />
            )}
            {phase === "idle" && <IdleContent />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
