"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check } from "lucide-react";
import { pageTransition, staggerChildren } from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import { useDecisions } from "@/hooks/useDecisions";
import { cn } from "@/lib/utils";
import DecisionCard from "@/components/decisions/DecisionCard";

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type Tab = "pending" | "resolved";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DecisionsPage() {
  const { companyId } = useDashboard();
  const { pending, resolved, pendingCount, resolvedCount, approve, reject, isLoading } =
    useDecisions(companyId);
  const [tab, setTab] = useState<Tab>("pending");

  const decisions = tab === "pending" ? pending : resolved;

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
          Decisions
        </h1>
        <p className="mt-1 font-body text-sm text-text-secondary">
          {pendingCount} pending &middot; {resolvedCount} resolved
        </p>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-1">
        <button
          onClick={() => setTab("pending")}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-4 py-1.5 font-body text-sm transition-colors",
            tab === "pending"
              ? "bg-bg-surface-raised text-text-primary"
              : "text-text-secondary hover:text-text-primary"
          )}
        >
          Pending
          {pendingCount > 0 && (
            <span className="rounded-full bg-warning/20 px-1.5 py-0.5 font-mono text-[10px] text-warning">
              {pendingCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab("resolved")}
          className={cn(
            "rounded-full px-4 py-1.5 font-body text-sm transition-colors",
            tab === "resolved"
              ? "bg-bg-surface-raised text-text-primary"
              : "text-text-secondary hover:text-text-primary"
          )}
        >
          Resolved
        </button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex h-40 items-center justify-center">
          <span className="font-mono text-sm text-text-muted">Loading...</span>
        </div>
      )}

      {/* Content */}
      {!isLoading && (
        <>
          {/* Empty state — Pending */}
          {tab === "pending" && decisions.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent/10">
                <Check className="h-6 w-6 text-accent" />
              </div>
              <h2 className="mb-1 font-heading text-xl text-text-primary">
                All clear
              </h2>
              <p className="font-body text-sm text-text-secondary">
                No decisions waiting. The agents are operating within their
                authority.
              </p>
            </div>
          )}

          {/* Empty state — Resolved */}
          {tab === "resolved" && decisions.length === 0 && (
            <p className="py-12 text-center font-body text-sm text-text-muted italic">
              No resolved decisions yet.
            </p>
          )}

          {/* Decision cards */}
          {decisions.length > 0 && (
            <motion.div
              variants={staggerChildren(0.06)}
              initial="hidden"
              animate="visible"
              className="space-y-4"
            >
              <AnimatePresence mode="popLayout">
                {decisions.map((d) => (
                  <DecisionCard
                    key={d.id}
                    decision={d}
                    onApprove={approve}
                    onReject={reject}
                  />
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </>
      )}
    </motion.div>
  );
}
