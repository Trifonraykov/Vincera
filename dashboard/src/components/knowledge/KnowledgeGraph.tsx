"use client";

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { Knowledge } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface KnowledgeGraphProps {
  entries: Knowledge[];
  categories: string[];
  companyName: string | null;
  onEntryClick: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTAINER_H = 300;
const CENTER_R = 32;
const CATEGORY_R = 20;
const LEAF_R = 5;
const CATEGORY_ORBIT = 110;
const LEAF_ORBIT = 50;
const MAX_LEAVES = 6;

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

interface TooltipData {
  x: number;
  y: number;
  label: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function KnowledgeGraph({
  entries,
  categories,
  companyName,
  onEntryClick,
}: KnowledgeGraphProps) {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  // Group entries by category (capped)
  const grouped = useMemo(() => {
    const map: Record<string, Knowledge[]> = {};
    for (const e of entries) {
      if (!map[e.category]) map[e.category] = [];
      if (map[e.category].length < MAX_LEAVES) {
        map[e.category].push(e);
      }
    }
    return map;
  }, [entries]);

  const cats = categories.slice(0, 8);
  const cy = CONTAINER_H / 2;

  if (entries.length === 0) {
    return (
      <div
        className="relative mb-6 flex items-center justify-center overflow-hidden rounded-lg border border-border-primary bg-bg-surface"
        style={{ height: CONTAINER_H }}
      >
        <div
          className="absolute inset-0 opacity-10"
          style={{
            background:
              "radial-gradient(circle at 50% 50%, rgba(0,255,136,0.15) 0%, transparent 60%)",
          }}
        />
        <p className="relative font-body text-sm text-text-muted italic">
          Knowledge graph will populate as the system learns about your company.
        </p>
      </div>
    );
  }

  // Compute positions
  type NodePos = { x: number; y: number };

  function catPosition(i: number, total: number): NodePos {
    const angle = (2 * Math.PI * i) / total - Math.PI / 2;
    return {
      x: Math.cos(angle) * CATEGORY_ORBIT,
      y: Math.sin(angle) * CATEGORY_ORBIT,
    };
  }

  function leafPositions(
    catIdx: number,
    totalCats: number,
    leafCount: number
  ): NodePos[] {
    const catAngle = (2 * Math.PI * catIdx) / totalCats - Math.PI / 2;
    const spread = Math.PI * 0.6;
    const startAngle = catAngle - spread / 2;
    const result: NodePos[] = [];
    for (let i = 0; i < leafCount; i++) {
      const a =
        leafCount === 1 ? catAngle : startAngle + (spread * i) / (leafCount - 1);
      const cp = catPosition(catIdx, totalCats);
      result.push({
        x: cp.x + Math.cos(a) * LEAF_ORBIT,
        y: cp.y + Math.sin(a) * LEAF_ORBIT,
      });
    }
    return result;
  }

  return (
    <div
      className="relative mb-6 overflow-hidden rounded-lg border border-border-primary bg-bg-surface"
      style={{ height: CONTAINER_H }}
    >
      {/* SVG connection lines */}
      <svg
        className="absolute inset-0 h-full w-full"
        style={{ pointerEvents: "none" }}
      >
        {cats.map((cat, i) => {
          const pos = catPosition(i, cats.length);
          return (
            <g key={`lines-${cat}`}>
              {/* Center → Category */}
              <line
                x1="50%"
                y1={cy}
                x2={`calc(50% + ${pos.x}px)`}
                y2={cy + pos.y}
                stroke="#1A1A1A"
                strokeWidth={1}
              />
              {/* Category → Leaves */}
              {(grouped[cat] ?? []).map((entry, li) => {
                const leaves = leafPositions(
                  i,
                  cats.length,
                  grouped[cat]?.length ?? 0
                );
                const lp = leaves[li];
                if (!lp) return null;
                return (
                  <line
                    key={entry.id}
                    x1={`calc(50% + ${pos.x}px)`}
                    y1={cy + pos.y}
                    x2={`calc(50% + ${lp.x}px)`}
                    y2={cy + lp.y}
                    stroke="#1A1A1A"
                    strokeWidth={0.5}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>

      {/* Center node */}
      <motion.div
        className="absolute flex items-center justify-center rounded-full border-2 border-accent bg-bg-surface"
        style={{
          width: CENTER_R * 2,
          height: CENTER_R * 2,
          left: "50%",
          top: cy,
          transform: "translate(-50%, -50%)",
          zIndex: 10,
        }}
        whileHover={{ scale: 1.1 }}
      >
        <span className="font-heading text-sm text-accent">
          {companyName ? companyName.charAt(0).toUpperCase() : "V"}
        </span>
      </motion.div>

      {/* Category nodes */}
      {cats.map((cat, i) => {
        const pos = catPosition(i, cats.length);
        const count = grouped[cat]?.length ?? 0;
        return (
          <motion.div
            key={cat}
            className="absolute flex cursor-default items-center justify-center rounded-full border border-border-primary bg-bg-surface-raised"
            style={{
              width: CATEGORY_R * 2,
              height: CATEGORY_R * 2,
              left: `calc(50% + ${pos.x}px)`,
              top: cy + pos.y,
              transform: "translate(-50%, -50%)",
              zIndex: 5,
            }}
            whileHover={{
              scale: 1.15,
              borderColor: "#00FF88",
            }}
            onMouseEnter={(e) => {
              const rect = (
                e.currentTarget.parentElement as HTMLElement
              ).getBoundingClientRect();
              const elRect = e.currentTarget.getBoundingClientRect();
              setTooltip({
                x: elRect.left - rect.left + CATEGORY_R,
                y: elRect.top - rect.top - 8,
                label: cat,
                detail: `${count} ${count === 1 ? "entry" : "entries"}`,
              });
            }}
            onMouseLeave={() => setTooltip(null)}
          >
            <span className="font-mono text-[10px] text-text-primary">
              {cat.slice(0, 3)}
            </span>
          </motion.div>
        );
      })}

      {/* Leaf nodes */}
      {cats.map((cat, catIdx) => {
        const leaves = grouped[cat] ?? [];
        const positions = leafPositions(catIdx, cats.length, leaves.length);
        return leaves.map((entry, li) => {
          const lp = positions[li];
          if (!lp) return null;
          return (
            <motion.div
              key={entry.id}
              className="absolute cursor-pointer rounded-full bg-accent/30"
              style={{
                width: LEAF_R * 2,
                height: LEAF_R * 2,
                left: `calc(50% + ${lp.x}px)`,
                top: cy + lp.y,
                transform: "translate(-50%, -50%)",
                zIndex: 3,
              }}
              whileHover={{
                scale: 2,
                backgroundColor: "rgba(0, 255, 136, 0.8)",
              }}
              onClick={() => onEntryClick(entry.id)}
              onMouseEnter={(e) => {
                const rect = (
                  e.currentTarget.parentElement as HTMLElement
                ).getBoundingClientRect();
                const elRect = e.currentTarget.getBoundingClientRect();
                setTooltip({
                  x: elRect.left - rect.left + LEAF_R,
                  y: elRect.top - rect.top - 8,
                  label: entry.title,
                  detail: entry.content.length > 60
                    ? entry.content.slice(0, 60) + "\u2026"
                    : entry.content,
                });
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          );
        });
      })}

      {/* Tooltip */}
      {tooltip && (
        <div
          className={cn(
            "pointer-events-none absolute z-20 rounded-md border border-border-primary bg-bg-surface-raised px-3 py-2 shadow-lg"
          )}
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: "translate(-50%, -100%)",
          }}
        >
          <p className="font-mono text-xs text-text-primary">{tooltip.label}</p>
          <p className="font-body text-[10px] text-text-muted">
            {tooltip.detail}
          </p>
        </div>
      )}
    </div>
  );
}
