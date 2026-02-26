"use client";

import { useState } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { cardEntrance, staggerChildren } from "@/lib/animations";
import { cn } from "@/lib/utils";
import type { Json } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PriorityQueueProps {
  queue: Json | null;
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
  return "";
}

function asNum(val: Json | null | undefined): number {
  if (typeof val === "number") return val;
  return 0;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueueItem {
  rank: number;
  description: string;
  score: number;
  assignedAgent: string;
  status: string;
  source: string;
  scoreBreakdown: {
    businessImpact: number;
    feasibility: number;
    urgency: number;
    researchBoost: number;
  } | null;
}

function parseItems(queue: Json | null): QueueItem[] {
  const obj = asObj(queue);
  const items = asArr(obj?.items ?? queue); // Support both { items: [...] } and [...]

  return items.map((item, i) => {
    const o = asObj(item);
    const bd = asObj(o?.score_breakdown);
    return {
      rank: typeof o?.rank === "number" ? o.rank : i + 1,
      description: asStr(o?.description) || asStr(o?.task) || "Unknown task",
      score: asNum(o?.score),
      assignedAgent: asStr(o?.assigned_agent) || asStr(o?.agent) || "—",
      status: asStr(o?.status),
      source: asStr(o?.source),
      scoreBreakdown: bd
        ? {
            businessImpact: asNum(bd.business_impact),
            feasibility: asNum(bd.feasibility),
            urgency: asNum(bd.urgency),
            researchBoost: asNum(bd.research_boost),
          }
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Score bar
// ---------------------------------------------------------------------------

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color =
    score >= 0.8
      ? "bg-accent"
      : score >= 0.5
        ? "bg-warning"
        : "bg-error";

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 rounded-full bg-bg-primary">
        <div
          className={cn("h-full rounded-full transition-all", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[10px] text-text-muted">
        {score.toFixed(2)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breakdown tooltip
// ---------------------------------------------------------------------------

function BreakdownTooltip({
  breakdown,
  total,
}: {
  breakdown: NonNullable<QueueItem["scoreBreakdown"]>;
  total: number;
}) {
  const rows = [
    { label: "Business Impact", value: breakdown.businessImpact },
    { label: "Feasibility", value: breakdown.feasibility },
    { label: "Urgency", value: breakdown.urgency },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.15 }}
      className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-border-primary bg-bg-surface-raised p-3 shadow-lg"
    >
      <p className="mb-2 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
        Score Breakdown
      </p>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2">
            <span className="w-24 font-body text-[10px] text-text-muted">
              {r.label}
            </span>
            <div className="h-1 w-14 rounded-full bg-bg-primary">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.round(r.value * 100)}%` }}
              />
            </div>
            <span className="font-mono text-[10px] text-text-secondary">
              {r.value.toFixed(2)}
            </span>
          </div>
        ))}
        {breakdown.researchBoost > 0 && (
          <div className="flex items-center gap-2">
            <span className="w-24 font-body text-[10px] text-text-muted">
              Research Boost
            </span>
            <span className="font-mono text-[10px] text-accent">
              +{breakdown.researchBoost.toFixed(2)}
            </span>
          </div>
        )}
      </div>
      <div className="mt-2 border-t border-border-primary pt-1.5">
        <div className="flex items-center justify-between">
          <span className="font-body text-[10px] text-text-muted">Total</span>
          <span className="font-mono text-xs text-text-primary">
            {total.toFixed(2)}
          </span>
        </div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Queue item row
// ---------------------------------------------------------------------------

function QueueItemRow({ item }: { item: QueueItem }) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  return (
    <motion.div
      layout
      variants={cardEntrance}
      className="relative rounded-md bg-bg-primary px-3 py-2"
      onMouseEnter={() => setShowBreakdown(true)}
      onMouseLeave={() => setShowBreakdown(false)}
    >
      <div className="flex items-start gap-3">
        {/* Rank */}
        <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-sm text-text-muted">
          {item.rank}
        </span>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <ScoreBar score={item.score} />
          </div>

          <p className="truncate font-body text-sm text-text-primary" title={item.description}>
            {item.description}
          </p>

          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-accent">
              {item.assignedAgent}
            </span>
            {item.status && (
              <span className="font-mono text-[10px] text-text-muted">
                {item.status.replace(/_/g, " ")}
              </span>
            )}
            {item.source === "research" && (
              <span title="Research-backed">📚</span>
            )}
            {item.source === "ghost" && (
              <span title="Ghost-observed">👻</span>
            )}
          </div>
        </div>
      </div>

      {/* Breakdown tooltip on hover */}
      <AnimatePresence>
        {showBreakdown && item.scoreBreakdown && (
          <BreakdownTooltip
            breakdown={item.scoreBreakdown}
            total={item.score}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function PriorityQueue({ queue }: PriorityQueueProps) {
  const items = parseItems(queue);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border-primary bg-bg-surface p-4">
      <h3 className="mb-3 font-heading text-lg text-text-primary">
        Priority Queue
      </h3>

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="py-4 font-body text-xs text-text-muted italic">
            No items in queue. The Orchestrator will populate this on the next
            cycle.
          </p>
        ) : (
          <LayoutGroup>
            <motion.div
              variants={staggerChildren(0.05)}
              initial="hidden"
              animate="visible"
              className="space-y-2"
            >
              {items.map((item) => (
                <QueueItemRow key={`${item.rank}-${item.description}`} item={item} />
              ))}
            </motion.div>
          </LayoutGroup>
        )}
      </div>
    </div>
  );
}
