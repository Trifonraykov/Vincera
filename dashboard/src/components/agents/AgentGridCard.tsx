"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  Brain,
  Search,
  GraduationCap,
  Hammer,
  Activity,
  BarChart3,
  Zap,
  Lightbulb,
} from "lucide-react";
import { cardEntrance, breathe } from "@/lib/animations";
import { cn, truncate } from "@/lib/utils";
import type { AgentStatus } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  orchestrator: Brain,
  discovery: Search,
  research: GraduationCap,
  builder: Hammer,
  operator: Activity,
  analyst: BarChart3,
  unstuck: Zap,
  trainer: Lightbulb,
};

const AGENTS = [
  "orchestrator",
  "discovery",
  "research",
  "builder",
  "operator",
  "analyst",
  "unstuck",
  "trainer",
] as const;

// ---------------------------------------------------------------------------
// Single cell
// ---------------------------------------------------------------------------

function AgentCell({ name, status }: { name: string; status?: AgentStatus }) {
  const Icon = ICON_MAP[name] ?? Brain;
  const isRunning = status?.status === "running";
  const statusLabel = status?.status ?? "offline";

  return (
    <Link href={`/dashboard/agents/${name}`}>
      <motion.div
        variants={cardEntrance}
        whileHover={{ y: -1, borderColor: "#2A2A2A" }}
        className="group rounded-md border border-border-primary bg-bg-surface p-3 transition-colors"
      >
        <motion.div
          variants={isRunning ? breathe : undefined}
          animate={isRunning ? "animate" : undefined}
          className="flex items-center gap-2"
        >
          <Icon
            className={cn(
              "h-4 w-4 shrink-0",
              isRunning ? "text-accent" : "text-text-secondary"
            )}
          />
          <span className="flex-1 truncate font-body text-xs font-medium capitalize text-text-primary">
            {name}
          </span>
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
              isRunning
                ? "bg-accent animate-pulse"
                : statusLabel === "failed"
                  ? "bg-error"
                  : statusLabel === "paused" || statusLabel === "blocked"
                    ? "bg-warning"
                    : "bg-text-muted"
            )}
          />
        </motion.div>

        {/* Current task or status */}
        <p className="mt-1.5 truncate font-mono text-[10px] text-text-muted">
          {isRunning && status?.current_task
            ? truncate(status.current_task, 40)
            : statusLabel}
        </p>
      </motion.div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

interface AgentGridCardProps {
  statuses: AgentStatus[];
}

export default function AgentGridCard({ statuses }: AgentGridCardProps) {
  const statusMap = new Map<string, AgentStatus>();
  statuses.forEach((s) => statusMap.set(s.agent_name, s));

  return (
    <div className="rounded-lg border border-border-primary bg-bg-surface p-4">
      <h3 className="mb-3 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
        Agents
      </h3>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {AGENTS.map((name) => (
          <AgentCell key={name} name={name} status={statusMap.get(name)} />
        ))}
      </div>
    </div>
  );
}
