"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Eye, Clock, Zap, ListChecks, FileText } from "lucide-react";
import {
  pageTransition,
  staggerChildren,
  cardEntrance,
  useNumberCountUp,
} from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import { useGhostReports } from "@/hooks/useGhostReports";
import ConfirmModal from "@/components/ui/ConfirmModal";
import GhostDayCard from "@/components/ghost/GhostDayCard";

// ---------------------------------------------------------------------------
// Stat Card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  suffix,
  icon: Icon,
}: {
  label: string;
  value: number;
  suffix?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  const animated = useNumberCountUp(value, 1.2);
  return (
    <motion.div
      variants={cardEntrance}
      className="rounded-lg border border-border-primary bg-bg-surface p-4"
    >
      <div className="mb-1 flex items-center gap-2">
        <Icon className="h-4 w-4 text-text-muted" />
        <span className="font-body text-xs text-text-muted">{label}</span>
      </div>
      <span className="font-mono text-3xl text-text-primary">
        {animated}
        {suffix && (
          <span className="ml-0.5 text-lg text-text-secondary">{suffix}</span>
        )}
      </span>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function GhostModePage() {
  const { companyId, company } = useDashboard();
  const { reports, ghostState, totals, isLoading, switchToActive } =
    useGhostReports(companyId);

  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);

  async function handleSwitchToActive() {
    setConfirmLoading(true);
    await switchToActive();
    setConfirmLoading(false);
    setShowConfirm(false);
  }

  const endDateStr = company?.ghost_mode_until
    ? new Date(company.ghost_mode_until).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  // Subtitle
  let subtitle = "";
  if (ghostState.isGhostActive) {
    subtitle = `${ghostState.daysTotal}-day observation period \u2014 day ${ghostState.daysElapsed} of ${ghostState.daysTotal}`;
  } else if (ghostState.isGhostCompleted) {
    subtitle = `Observation complete \u2014 ${totals.totalReports} days recorded`;
  } else {
    subtitle = "Ghost mode has not been activated";
  }

  return (
    <motion.div
      variants={pageTransition}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <Eye className="h-6 w-6 text-text-muted" />
          <h1 className="font-heading text-3xl font-semibold text-text-primary">
            Ghost Mode
          </h1>
        </div>
        <p className="mt-1 font-body text-sm text-text-secondary">{subtitle}</p>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex h-40 items-center justify-center">
          <span className="font-mono text-sm text-text-muted">Loading...</span>
        </div>
      )}

      {/* ================================================================= */}
      {/* STATE: Never in ghost mode                                         */}
      {/* ================================================================= */}
      {!isLoading && ghostState.neverGhost && (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-bg-surface-raised">
            <Eye className="h-8 w-8 text-text-muted" />
          </div>
          <h2 className="mb-2 font-heading text-2xl text-text-primary">
            Ghost Mode Not Active
          </h2>
          <p className="max-w-md text-center font-body text-sm text-text-secondary">
            Ghost mode is a 7-day observation period where Vincera watches your
            workflows without making any changes. Each day, you receive a report
            showing what the system would have automated and how much time it
            estimates you&apos;d save.
          </p>
          <p className="mt-4 font-mono text-xs text-text-muted">
            Ghost mode activates automatically when the system first connects to
            your company.
          </p>
        </div>
      )}

      {/* ================================================================= */}
      {/* STATE: Active ghost mode                                           */}
      {/* ================================================================= */}
      {!isLoading && ghostState.isGhostActive && (
        <>
          {/* Progress bar */}
          <div className="mb-6 rounded-lg border border-accent/20 bg-bg-surface p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
                <span className="font-body text-sm font-medium text-accent">
                  Ghost Mode Active
                </span>
              </div>
              <span className="font-mono text-xs text-text-muted">
                Day {ghostState.daysElapsed} of {ghostState.daysTotal}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-bg-primary">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${ghostState.progress * 100}%` }}
                transition={{
                  duration: 1.5,
                  ease: [0.33, 1, 0.68, 1],
                }}
                className="h-full rounded-full bg-accent"
              />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <p className="font-body text-xs text-text-secondary">
                Progress: {Math.round(ghostState.progress * 100)}%
              </p>
              {endDateStr && (
                <p className="font-mono text-[10px] text-text-muted">
                  Ends: {endDateStr}
                </p>
              )}
            </div>
          </div>

          {/* Switch to Active button */}
          <div className="mb-6 flex justify-end">
            <button
              onClick={() => setShowConfirm(true)}
              className="rounded-md border border-accent bg-accent/10 px-4 py-2 font-body text-sm font-medium text-accent transition-colors hover:bg-accent/20"
            >
              Switch to Active &rarr;
            </button>
          </div>
        </>
      )}

      {/* ================================================================= */}
      {/* STATE: Completed banner                                            */}
      {/* ================================================================= */}
      {!isLoading && ghostState.isGhostCompleted && (
        <div className="mb-6 rounded-lg border border-border-primary bg-bg-surface p-4">
          <p className="font-body text-sm text-text-secondary">
            Ghost mode observation is complete. The system learned from{" "}
            <span className="font-mono text-accent">
              {totals.totalReports}
            </span>{" "}
            days of watching your workflows.
          </p>
        </div>
      )}

      {/* ================================================================= */}
      {/* Running totals (active or completed)                               */}
      {/* ================================================================= */}
      {!isLoading && !ghostState.neverGhost && (
        <>
          <motion.div
            variants={staggerChildren(0.08)}
            initial="hidden"
            animate="visible"
            className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4"
          >
            <StatCard
              label="Days Observed"
              value={totals.totalReports}
              icon={FileText}
            />
            <StatCard
              label="Hours Est. Saved"
              value={totals.totalHoursSaved}
              suffix="h"
              icon={Clock}
            />
            <StatCard
              label="Would Automate"
              value={totals.totalTasksAutomated}
              icon={Zap}
            />
            <StatCard
              label="Processes Observed"
              value={totals.processesObserved}
              icon={ListChecks}
            />
          </motion.div>

          {/* Day cards */}
          {reports.length > 0 && (
            <motion.div
              variants={staggerChildren(0.06)}
              initial="hidden"
              animate="visible"
              className="space-y-4"
            >
              {reports.map((report, i) => {
                const dayNum = reports.length - i;
                const isToday =
                  new Date(report.report_date).toDateString() ===
                  new Date().toDateString();
                return (
                  <GhostDayCard
                    key={report.id}
                    report={report}
                    dayNumber={dayNum}
                    isToday={isToday}
                  />
                );
              })}
            </motion.div>
          )}

          {reports.length === 0 && (
            <p className="py-12 text-center font-body text-sm text-text-muted italic">
              No ghost reports yet. Reports are generated daily during the
              observation period.
            </p>
          )}
        </>
      )}

      {/* Confirm modal */}
      <ConfirmModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleSwitchToActive}
        title="Switch to Active Mode?"
        description={
          <>
            The system will begin actively automating based on{" "}
            <span className="font-mono text-accent">
              {ghostState.daysElapsed}
            </span>{" "}
            days of observation. The remaining{" "}
            <span className="font-mono">
              {Math.max(0, ghostState.daysTotal - ghostState.daysElapsed)}
            </span>{" "}
            observation days will be skipped. You can always pause the system
            later.
          </>
        }
        confirmLabel="Switch to Active"
        confirmVariant="accent"
        isLoading={confirmLoading}
      />
    </motion.div>
  );
}
