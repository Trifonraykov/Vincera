"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn, timeAgo } from "@/lib/utils";
import type { BrainState, Json } from "@/lib/supabase";
import { getNum, getStr, getObj } from "@/hooks/useBrainState";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DecisionTimelineProps {
  history: BrainState[];
  currentCycleNumber: number;
  selectedCycleNumber: number | null;
  onSelectCycle: (cycleNumber: number) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConfidence(state: Json): number {
  return getNum(state, "confidence") ?? 0;
}

function getCycleNumber(state: Json): number {
  return getNum(state, "cycle_number") ?? 0;
}

function getDuration(state: Json): number | null {
  return getNum(state, "duration_ms");
}

function getPhaseLabel(state: Json): string {
  return getStr(state, "ooda_phase") ?? "idle";
}

function hasFailures(state: Json): boolean {
  const results = getObj(state, "action_results");
  if (!results || typeof results !== "object" || Array.isArray(results)) return false;
  const arr = (results as Record<string, Json>).results;
  if (!Array.isArray(arr)) return false;
  return arr.some((r) => {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      return (r as Record<string, Json>).status === "failed";
    }
    return false;
  });
}

function nodeColor(state: Json): string {
  if (hasFailures(state)) return "bg-error";
  const conf = getConfidence(state);
  if (conf >= 0.8) return "bg-accent";
  if (conf >= 0.5) return "bg-warning";
  return "bg-error";
}

function nodeBorder(state: Json): string {
  if (hasFailures(state)) return "border-error";
  const conf = getConfidence(state);
  if (conf >= 0.8) return "border-accent";
  if (conf >= 0.5) return "border-warning";
  return "border-error";
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function NodeTooltip({ state }: { state: BrainState }) {
  const cn_ = getCycleNumber(state.state);
  const conf = getConfidence(state.state);
  const dur = getDuration(state.state);
  const phase = getPhaseLabel(state.state);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.12 }}
      className="absolute -top-20 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-border-primary bg-bg-primary px-3 py-2 shadow-lg"
    >
      <p className="font-mono text-xs text-text-primary">Cycle #{cn_}</p>
      <p className="font-mono text-[10px] text-text-muted">
        Phase: {phase}
      </p>
      {dur !== null && (
        <p className="font-mono text-[10px] text-text-muted">
          Duration: {(dur / 1000).toFixed(1)}s
        </p>
      )}
      <p className="font-mono text-[10px] text-text-muted">
        Confidence: {Math.round(conf * 100)}%
      </p>
      <div className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-b border-r border-border-primary bg-bg-primary" />
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Timeline node
// ---------------------------------------------------------------------------

function TimelineNode({
  state,
  isCurrent,
  isSelected,
  showLabel,
  onClick,
}: {
  state: BrainState;
  isCurrent: boolean;
  isSelected: boolean;
  showLabel: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const cycleNum = getCycleNumber(state.state);

  return (
    <div
      className="relative flex flex-col items-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Tooltip */}
      <AnimatePresence>
        {hovered && <NodeTooltip state={state} />}
      </AnimatePresence>

      {/* Node */}
      <button
        onClick={onClick}
        className={cn(
          "relative rounded-full transition-all",
          isCurrent ? "h-4 w-4" : "h-3 w-3",
          nodeColor(state.state),
          isSelected && "ring-2 ring-offset-1 ring-offset-bg-surface",
          isSelected && nodeBorder(state.state).replace("border-", "ring-")
        )}
      >
        {isCurrent && (
          <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-40" />
        )}
      </button>

      {/* Cycle number label */}
      {(showLabel || isCurrent) && (
        <span className="mt-1 font-mono text-[9px] text-text-muted">
          #{cycleNum}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function DecisionTimeline({
  history,
  currentCycleNumber,
  selectedCycleNumber,
  onSelectCycle,
}: DecisionTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the right (latest) on mount and when history updates
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [history.length]);

  if (history.length === 0) {
    return (
      <div className="rounded-lg border border-border-primary bg-bg-surface p-4">
        <h3 className="mb-3 font-body text-xs font-semibold uppercase tracking-widest text-text-secondary">
          Cycle History
        </h3>
        <p className="font-body text-xs text-text-muted italic">
          No cycles yet. The Orchestrator hasn&apos;t run its first cycle.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border-primary bg-bg-surface p-4">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-body text-xs font-semibold uppercase tracking-widest text-text-secondary">
          Cycle History
        </h3>
        <div className="flex items-center gap-3 font-mono text-[10px] text-text-muted">
          {history.length > 0 && (
            <span>{timeAgo(history[0].created_at)} \u2190</span>
          )}
          <span>now</span>
        </div>
      </div>

      {/* Scrollable timeline */}
      <div
        ref={scrollRef}
        className="flex items-center gap-0 overflow-x-auto pb-2 scrollbar-none"
      >
        {history.map((state, i) => {
          const cycleNum = getCycleNumber(state.state);
          const isCurrent = cycleNum === currentCycleNumber;
          const isSelected = cycleNum === selectedCycleNumber;
          const showLabel = cycleNum % 5 === 0;

          return (
            <div key={state.id} className="flex items-center">
              {/* Connecting line (before each node except the first) */}
              {i > 0 && (
                <div className="h-px w-6 bg-border-primary sm:w-8 lg:w-10" />
              )}

              <TimelineNode
                state={state}
                isCurrent={isCurrent}
                isSelected={isSelected}
                showLabel={showLabel}
                onClick={() => onSelectCycle(cycleNum)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
