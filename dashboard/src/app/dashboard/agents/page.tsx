"use client";

import { motion } from "framer-motion";
import Link from "next/link";
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
import { pageTransition, cardEntrance, staggerChildren, breathe } from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import { cn, timeAgo, agentStatusColor } from "@/lib/utils";
import type { AgentStatus } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Agent config
// ---------------------------------------------------------------------------

const AGENTS = [
  { name: "orchestrator", label: "Orchestrator", icon: Brain },
  { name: "discovery", label: "Discovery", icon: Search },
  { name: "research", label: "Research", icon: GraduationCap },
  { name: "builder", label: "Builder", icon: Hammer },
  { name: "operator", label: "Operator", icon: Activity },
  { name: "analyst", label: "Analyst", icon: BarChart3 },
  { name: "unstuck", label: "Unstuck", icon: Zap },
  { name: "trainer", label: "Trainer", icon: Lightbulb },
] as const;

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function AgentCard({
  agent,
  status,
}: {
  agent: (typeof AGENTS)[number];
  status: AgentStatus | undefined;
}) {
  const Icon = agent.icon;
  const isRunning = status?.status === "running";
  const statusLabel = status?.status ?? "offline";
  const colorClass = status ? agentStatusColor(status.status) : "text-text-muted";

  return (
    <Link href={`/dashboard/agents/${agent.name}`}>
      <motion.div
        variants={cardEntrance}
        whileHover={{ y: -2, borderColor: "#2A2A2A" }}
        className="group cursor-pointer rounded-lg border border-border-primary bg-bg-surface p-5 transition-colors"
      >
        <motion.div
          variants={isRunning ? breathe : undefined}
          animate={isRunning ? "animate" : undefined}
        >
          {/* Icon */}
          <Icon
            className={cn(
              "mb-3 h-6 w-6",
              isRunning ? "text-accent" : "text-text-secondary"
            )}
          />

          {/* Name */}
          <h3 className="mb-2 font-heading text-base font-semibold text-text-primary">
            {agent.label}
          </h3>

          {/* Status */}
          <div className="mb-2 flex items-center gap-2">
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                isRunning
                  ? "bg-accent animate-pulse"
                  : statusLabel === "failed"
                    ? "bg-error"
                    : statusLabel === "paused" || statusLabel === "blocked"
                      ? "bg-warning"
                      : "bg-text-muted"
              )}
            />
            <span className={cn("font-body text-xs", colorClass)}>
              {statusLabel}
            </span>
          </div>

          {/* Task / last activity */}
          <p className="truncate font-mono text-xs text-text-muted">
            {isRunning && status?.current_task
              ? status.current_task
              : status?.last_run
                ? `Last active ${timeAgo(status.last_run)}`
                : "No activity"}
          </p>
        </motion.div>
      </motion.div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AgentsPage() {
  const { agentStatuses } = useDashboard();

  const statusMap = new Map<string, AgentStatus>();
  agentStatuses.forEach((s) => statusMap.set(s.agent_name, s));

  return (
    <motion.div
      variants={pageTransition}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-heading text-3xl font-semibold text-text-primary">
          Agents
        </h1>
        <p className="mt-1 font-body text-sm text-text-secondary">
          Talk to any agent. They remember everything.
        </p>
      </div>

      {/* Grid */}
      <motion.div
        variants={staggerChildren(0.06)}
        initial="hidden"
        animate="visible"
        className="grid grid-cols-2 gap-4 lg:grid-cols-4"
      >
        {AGENTS.map((agent) => (
          <AgentCard
            key={agent.name}
            agent={agent}
            status={statusMap.get(agent.name)}
          />
        ))}
      </motion.div>
    </motion.div>
  );
}
