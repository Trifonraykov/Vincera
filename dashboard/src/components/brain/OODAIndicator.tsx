"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { OodaPhase } from "@/hooks/useBrainState";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface OODAIndicatorProps {
  currentPhase: OodaPhase;
  cycleNumber: number;
  confidence: number;
  durationMs: number | null;
  startedAt: string | null;
}

// ---------------------------------------------------------------------------
// Phase config
// ---------------------------------------------------------------------------

const PHASES: { key: OodaPhase; label: string }[] = [
  { key: "observing", label: "OBSERVE" },
  { key: "orienting", label: "ORIENT" },
  { key: "deciding", label: "DECIDE" },
  { key: "acting", label: "ACT" },
];

const PHASE_INDEX: Record<string, number> = {
  observing: 0,
  orienting: 1,
  deciding: 2,
  acting: 3,
  learning: 4,
  idle: -1,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const remainder = Math.round(s % 60);
  return `${m}m ${remainder}s`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "—";
  }
}

// ---------------------------------------------------------------------------
// SVG constants
// ---------------------------------------------------------------------------

const SVG_WIDTH = 520;
const SVG_HEIGHT = 80;
const CX_START = 60;
const CX_GAP = 133;
const CY = 32;
const R_NORMAL = 14;
const R_ACTIVE = 16;
const R_DOT = 3;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OODAIndicator({
  currentPhase,
  cycleNumber,
  confidence,
  durationMs,
  startedAt,
}: OODAIndicatorProps) {
  const activeIdx = PHASE_INDEX[currentPhase] ?? -1;
  const isLearning = currentPhase === "learning";
  const isIdle = currentPhase === "idle";

  const confPct = Math.round(confidence * 100);
  const confColor =
    confidence >= 0.8
      ? "text-accent"
      : confidence >= 0.5
        ? "text-warning"
        : "text-error";

  return (
    <div className="rounded-lg border border-border-primary bg-bg-surface p-5">
      {/* SVG indicator */}
      <div className="flex justify-center">
        <svg
          viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
          className="w-full max-w-lg"
          aria-label="OODA phase indicator"
        >
          {/* Glow filter */}
          <defs>
            <filter id="ooda-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Connecting lines */}
          {PHASES.slice(0, -1).map((_, i) => {
            const x1 = CX_START + i * CX_GAP + R_NORMAL + 2;
            const x2 = CX_START + (i + 1) * CX_GAP - R_NORMAL - 2;

            // Line is "completed" if both endpoints are completed or active
            const lineCompleted = i < activeIdx || isLearning;
            const lineActive = i === activeIdx - 1 && !isLearning && !isIdle;

            return (
              <motion.line
                key={`line-${i}`}
                x1={x1}
                y1={CY}
                x2={x2}
                y2={CY}
                strokeWidth={lineActive ? 2 : 1}
                animate={{
                  stroke: lineActive
                    ? "#00FF88"
                    : lineCompleted
                      ? "#888888"
                      : "#1A1A1A",
                }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                // Animated dash for active segment
                strokeDasharray={lineActive ? "6 4" : "none"}
              >
                {lineActive && (
                  <animate
                    attributeName="stroke-dashoffset"
                    from="20"
                    to="0"
                    dur="1s"
                    repeatCount="indefinite"
                  />
                )}
              </motion.line>
            );
          })}

          {/* Phase circles + labels */}
          {PHASES.map((phase, i) => {
            const cx = CX_START + i * CX_GAP;
            const isActive = i === activeIdx;
            const isCompleted = activeIdx > i || isLearning;
            const allGlow = isLearning;

            return (
              <g key={phase.key}>
                {/* Main circle */}
                <motion.circle
                  cx={cx}
                  cy={CY}
                  animate={{
                    r: isActive && !isIdle ? R_ACTIVE : R_NORMAL,
                    fill:
                      isActive || allGlow
                        ? "#00FF88"
                        : "transparent",
                    stroke:
                      isCompleted && !allGlow
                        ? "#888888"
                        : isActive || allGlow
                          ? "#00FF88"
                          : "#1A1A1A",
                    strokeWidth: isActive || allGlow ? 0 : 1.5,
                  }}
                  filter={isActive || allGlow ? "url(#ooda-glow)" : undefined}
                  transition={{ duration: 0.4, ease: "easeOut" }}
                />

                {/* Completed dot (small center circle) */}
                {isCompleted && !isActive && !allGlow && (
                  <motion.circle
                    cx={cx}
                    cy={CY}
                    r={R_DOT}
                    fill="#00FF88"
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.3 }}
                  />
                )}

                {/* Label */}
                <motion.text
                  x={cx}
                  y={CY + 30}
                  textAnchor="middle"
                  className="font-body text-[11px]"
                  animate={{
                    fill: isActive ? "#FFFFFF" : isCompleted ? "#888888" : "#555555",
                    fontWeight: isActive ? 500 : 400,
                  }}
                  transition={{ duration: 0.3 }}
                >
                  {phase.label}
                </motion.text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Idle message */}
      {isIdle && (
        <p className="mt-2 text-center font-body text-xs text-text-muted italic">
          Waiting for next cycle...
        </p>
      )}

      {/* Metadata row */}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-6 font-mono text-xs">
        <span className="text-text-primary">
          Cycle #{cycleNumber || "—"}
        </span>
        <span className="text-text-muted">
          Started {formatTime(startedAt)}
        </span>
        <span className="text-text-muted">
          Last cycle: {durationMs !== null ? formatDuration(durationMs) : "—"}
        </span>
        <span className={cn(confColor)}>
          Confidence: {confPct}%
        </span>
      </div>
    </div>
  );
}
