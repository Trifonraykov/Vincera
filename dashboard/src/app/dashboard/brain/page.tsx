"use client";

import { motion } from "framer-motion";
import { pageTransition } from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import {
  useBrainState,
  getPhase,
  getObj,
  getNum,
} from "@/hooks/useBrainState";
import OODAIndicator from "@/components/brain/OODAIndicator";
import ThinkingPanel from "@/components/brain/ThinkingPanel";
import PriorityQueue from "@/components/brain/PriorityQueue";
import DecisionTimeline from "@/components/brain/DecisionTimeline";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BrainViewPage() {
  const { companyId } = useDashboard();
  const {
    current,
    history,
    selectedCycle,
    selectCycle,
    clearSelection,
    isLoading,
    isLive,
  } = useBrainState(companyId);

  // The brain state to display — either live current or the selected historical cycle
  const displayState = selectedCycle ?? current;

  // Extract data from the display state
  const phase = displayState ? getPhase(displayState.state) : "idle";
  const cycleNumber = displayState
    ? getNum(displayState.state, "cycle_number") ?? 0
    : 0;
  const confidence = displayState
    ? getNum(displayState.state, "confidence") ?? 0
    : 0;
  const durationMs = displayState
    ? getNum(displayState.state, "duration_ms")
    : null;
  const observations = displayState ? getObj(displayState.state, "observations") : null;
  const analysis = displayState ? getObj(displayState.state, "analysis") : null;
  const plannedActions = displayState
    ? getObj(displayState.state, "planned_actions")
    : null;
  const actionResults = displayState
    ? getObj(displayState.state, "action_results")
    : null;
  const priorityQueue = displayState
    ? getObj(displayState.state, "priority_queue")
    : null;

  // Start time: use created_at of the display state as a proxy
  const startedAt = displayState?.created_at ?? null;

  // Current cycle number for timeline highlighting
  const currentCycleNumber = current
    ? getNum(current.state, "cycle_number") ?? 0
    : 0;

  // Selected cycle number for timeline selection ring
  const selectedCycleNumber = selectedCycle
    ? getNum(selectedCycle.state, "cycle_number")
    : null;

  return (
    <motion.div
      variants={pageTransition}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <h1 className="font-heading text-3xl font-semibold text-text-primary">
            Brain View
          </h1>
          {isLive ? (
            <span className="flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-0.5 font-mono text-[10px] uppercase text-accent">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              Live
            </span>
          ) : (
            <span className="rounded-full bg-bg-surface-raised px-2.5 py-0.5 font-mono text-[10px] uppercase text-text-muted">
              Historical
            </span>
          )}
        </div>
        <p className="mt-1 font-body text-sm text-text-secondary">
          Orchestrator reasoning cycle — live
        </p>
      </div>

      {/* Historical mode banner */}
      {!isLive && selectedCycle && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-border-primary bg-bg-surface px-4 py-2.5">
          <p className="font-body text-sm text-text-secondary">
            Viewing Cycle #{selectedCycleNumber}{" "}
            <span className="text-text-muted">
              — {selectedCycle.created_at ? new Date(selectedCycle.created_at).toLocaleString() : ""}
            </span>
          </p>
          <button
            onClick={clearSelection}
            className="font-body text-xs text-accent transition-colors hover:text-accent/80"
          >
            ← Back to Live
          </button>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex h-64 items-center justify-center">
          <span className="font-mono text-sm text-text-muted">Loading brain state...</span>
        </div>
      )}

      {!isLoading && (
        <>
          {/* OODA Indicator — full width */}
          <div className="mb-4">
            <OODAIndicator
              currentPhase={phase}
              cycleNumber={cycleNumber}
              confidence={confidence}
              durationMs={durationMs}
              startedAt={startedAt}
            />
          </div>

          {/* ThinkingPanel + PriorityQueue — side by side */}
          <div className="mb-4 grid min-h-[320px] gap-4 lg:grid-cols-[3fr_2fr]">
            <ThinkingPanel
              phase={phase}
              observations={observations}
              analysis={analysis}
              plannedActions={plannedActions}
              actionResults={actionResults}
              confidence={confidence}
              cycleNumber={cycleNumber}
              durationMs={durationMs}
            />
            <PriorityQueue queue={priorityQueue} />
          </div>

          {/* DecisionTimeline — full width */}
          <DecisionTimeline
            history={history}
            currentCycleNumber={currentCycleNumber}
            selectedCycleNumber={selectedCycleNumber}
            onSelectCycle={selectCycle}
          />
        </>
      )}
    </motion.div>
  );
}
