"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  staggerChildren,
  slideInRight,
  dissolveIn,
  cardEntrance,
} from "@/lib/animations";
import { cn } from "@/lib/utils";
import type { Json } from "@/lib/supabase";
import type { OodaPhase } from "@/hooks/useBrainState";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ThinkingPanelProps {
  phase: OodaPhase;
  observations: Json | null;
  analysis: Json | null;
  plannedActions: Json | null;
  actionResults: Json | null;
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

// ---------------------------------------------------------------------------
// Phase content components
// ---------------------------------------------------------------------------

function ObservingContent({ data }: { data: Json | null }) {
  const obj = asObj(data);
  const items = asArr(obj?.items);

  if (items.length === 0) {
    return (
      <motion.p
        variants={dissolveIn}
        initial="hidden"
        animate="visible"
        className="font-body text-sm text-text-muted italic animate-pulse"
      >
        Gathering data...
      </motion.p>
    );
  }

  return (
    <motion.ul
      variants={staggerChildren(0.06)}
      initial="hidden"
      animate="visible"
      className="space-y-2"
    >
      {items.map((item, i) => {
        const o = asObj(item);
        const source = asStr(o?.source);
        const summary = asStr(o?.summary);
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
              {source && (
                <span className="mr-2 font-mono text-[10px] text-text-muted">
                  {source}
                </span>
              )}
              <span className="font-body text-sm text-text-secondary">
                {summary || "—"}
              </span>
            </div>
          </motion.li>
        );
      })}
    </motion.ul>
  );
}

function OrientingContent({ data }: { data: Json | null }) {
  const obj = asObj(data);
  const summary = asStr(obj?.summary);
  const keyFindings = asArr(obj?.key_findings);
  const risks = asArr(obj?.risks);

  if (!summary && keyFindings.length === 0 && risks.length === 0) {
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

function DecidingContent({ data }: { data: Json | null }) {
  const obj = asObj(data);
  const actions = asArr(obj?.actions);

  if (actions.length === 0) {
    return (
      <p className="font-body text-sm text-text-muted italic">
        No planned actions for this phase.
      </p>
    );
  }

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
        return "bg-text-muted/20 text-text-muted";
    }
  };

  return (
    <motion.ol
      variants={staggerChildren(0.08)}
      initial="hidden"
      animate="visible"
      className="space-y-3"
    >
      {actions.map((item, i) => {
        const a = asObj(item);
        const agent = asStr(a?.agent);
        const task = asStr(a?.task);
        const priority = typeof a?.priority === "number" ? a.priority : null;
        const authority = asStr(a?.authority);

        const prioColor =
          priority !== null && priority >= 0.8
            ? "text-accent"
            : priority !== null && priority >= 0.5
              ? "text-warning"
              : "text-text-muted";

        return (
          <motion.li key={i} variants={cardEntrance} className="rounded-md bg-bg-primary px-3 py-2">
            <div className="flex items-start gap-2">
              <span className="mt-0.5 font-mono text-xs text-text-muted">
                {i + 1}.
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-body text-sm text-text-primary">
                  <span className="font-mono text-accent">{agent}</span>
                  {" → "}
                  {task || "—"}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
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
          </motion.li>
        );
      })}
    </motion.ol>
  );
}

function ActingContent({ data }: { data: Json | null }) {
  const obj = asObj(data);
  const results = asArr(obj?.results);

  if (results.length === 0) {
    return (
      <p className="font-body text-sm text-text-muted italic">
        No execution results for this phase.
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

  return (
    <div className="space-y-2">
      {results.map((item, i) => {
        const r = asObj(item);
        const agent = asStr(r?.agent);
        const task = asStr(r?.task);
        const status = asStr(r?.status);
        const detail = asStr(r?.detail);
        const si = statusIcon(status);

        return (
          <div key={i} className="rounded-md bg-bg-primary px-3 py-2">
            <div className="flex items-start gap-2">
              <span className={cn("mt-0.5 font-mono text-sm", si.color)}>
                {si.icon}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-body text-sm text-text-primary">
                  <span className="font-mono text-accent">{agent}</span>
                  {" — "}
                  {task || "—"}
                </p>
                {detail && (
                  <p className="mt-0.5 font-mono text-[10px] text-text-muted">
                    {detail}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LearningContent({
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
        Cycle #{cycleNumber} complete. Updating playbooks and knowledge...
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

const PHASE_HEADERS: Record<OodaPhase, { title: string; subtitle: string }> = {
  observing: { title: "Observing", subtitle: "What I see" },
  orienting: { title: "Orienting", subtitle: "What I think" },
  deciding: { title: "Deciding", subtitle: "What I\u2019ll do" },
  acting: { title: "Acting", subtitle: "What\u2019s happening" },
  learning: { title: "Learning", subtitle: "What I learned" },
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
          — {header.subtitle}
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
            {phase === "observing" && <ObservingContent data={observations} />}
            {phase === "orienting" && <OrientingContent data={analysis} />}
            {phase === "deciding" && <DecidingContent data={plannedActions} />}
            {phase === "acting" && <ActingContent data={actionResults} />}
            {phase === "learning" && (
              <LearningContent
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
