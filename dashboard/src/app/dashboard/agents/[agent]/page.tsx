"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
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
import { pageTransition, breathe } from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import { useAgentStatus } from "@/hooks/useAgentStatus";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { PlaybookEntry, Json } from "@/lib/supabase";
import { cn, timeAgo, agentStatusColor } from "@/lib/utils";
import ChatWindow from "@/components/chat/ChatWindow";

// ---------------------------------------------------------------------------
// Icon map
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

const LABEL_MAP: Record<string, string> = {
  orchestrator: "Orchestrator",
  discovery: "Discovery",
  research: "Research",
  builder: "Builder",
  operator: "Operator",
  analyst: "Analyst",
  unstuck: "Unstuck",
  trainer: "Trainer",
};

// ---------------------------------------------------------------------------
// Info Panel
// ---------------------------------------------------------------------------

function AgentInfoPanel({
  agentName,
  companyId,
}: {
  agentName: string;
  companyId: string;
}) {
  const { status } = useAgentStatus(companyId, agentName);
  const [playbook, setPlaybook] = useState<PlaybookEntry[]>([]);
  const [priorityQueue, setPriorityQueue] = useState<
    { task: string; priority: number }[]
  >([]);

  // Fetch playbook entries
  useEffect(() => {
    if (!companyId || !isSupabaseConfigured()) return;
    const supabase = createBrowserClient();
    async function fetchPlaybook() {
      const { data } = await supabase
        .from("playbook_entries")
        .select("*")
        .eq("company_id", companyId)
        .eq("agent_name", agentName)
        .order("last_used", { ascending: false })
        .limit(5);
      if (data) setPlaybook(data as PlaybookEntry[]);
    }
    fetchPlaybook();
  }, [companyId, agentName]);

  // Fetch priority queue for orchestrator
  useEffect(() => {
    if (agentName !== "orchestrator" || !companyId || !isSupabaseConfigured())
      return;
    const supabase = createBrowserClient();
    async function fetchBrain() {
      const { data } = await supabase
        .from("brain_states")
        .select("state")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (data?.state && typeof data.state === "object") {
        const state = data.state as Record<string, Json>;
        const queue = state.priority_queue;
        if (Array.isArray(queue)) {
          setPriorityQueue(
            queue.map((item: Json) => {
              if (typeof item === "object" && item && !Array.isArray(item)) {
                const obj = item as Record<string, Json>;
                return {
                  task: typeof obj.task === "string" ? obj.task : "Unknown",
                  priority: typeof obj.priority === "number" ? obj.priority : 0,
                };
              }
              return { task: String(item), priority: 0 };
            })
          );
        }
      }
    }
    fetchBrain();
  }, [companyId, agentName]);

  const isRunning = status?.status === "running";
  const statusLabel = status?.status ?? "offline";
  const colorClass = status ? agentStatusColor(status.status) : "text-text-muted";

  // Compute success rate from playbook entries
  const successCount = playbook.filter((p) => p.success).length;
  const successRate =
    playbook.length > 0
      ? ((successCount / playbook.length) * 100).toFixed(1)
      : null;

  return (
    <div className="space-y-6 overflow-y-auto">
      {/* Status card */}
      <div className="rounded-lg border border-border-primary bg-bg-surface p-4">
        <h3 className="mb-3 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
          Status
        </h3>

        <div className="space-y-3">
          {/* Status */}
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-block h-2 w-2 rounded-full",
                isRunning
                  ? "bg-accent animate-pulse"
                  : statusLabel === "failed"
                    ? "bg-error"
                    : statusLabel === "paused" || statusLabel === "blocked"
                      ? "bg-warning"
                      : "bg-text-muted"
              )}
            />
            <span className={cn("font-body text-sm", colorClass)}>
              {statusLabel}
            </span>
          </div>

          {/* Current task */}
          {status?.current_task && (
            <div>
              <p className="font-body text-xs text-text-muted">Current Task</p>
              <p className="mt-0.5 font-mono text-xs text-text-secondary">
                {status.current_task}
              </p>
            </div>
          )}

          {/* Success rate */}
          {successRate !== null && (
            <div>
              <p className="font-body text-xs text-text-muted">Success Rate</p>
              <p
                className={cn(
                  "mt-0.5 font-mono text-sm font-medium",
                  parseFloat(successRate) > 90
                    ? "text-accent"
                    : parseFloat(successRate) < 70
                      ? "text-warning"
                      : "text-text-primary"
                )}
              >
                {successRate}%
              </p>
            </div>
          )}

          {/* Last run */}
          {status?.last_run && (
            <div>
              <p className="font-body text-xs text-text-muted">Last Run</p>
              <p className="mt-0.5 font-mono text-xs text-text-secondary">
                {timeAgo(status.last_run)}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Recent Playbook */}
      <div className="rounded-lg border border-border-primary bg-bg-surface p-4">
        <h3 className="mb-3 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
          Recent Playbook
        </h3>

        {playbook.length > 0 ? (
          <div className="space-y-2">
            {playbook.map((entry) => (
              <div
                key={entry.id}
                className="flex items-start gap-2 rounded bg-bg-primary px-2 py-1.5"
              >
                <span
                  className={cn(
                    "mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                    entry.success ? "bg-accent" : "bg-error"
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-body text-xs text-text-secondary">
                    {entry.task}
                  </p>
                  {entry.outcome && (
                    <p className="truncate font-mono text-[10px] text-text-muted">
                      {entry.outcome}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="font-body text-xs text-text-muted italic">
            No playbook entries yet
          </p>
        )}
      </div>

      {/* Orchestrator: Priority Queue */}
      {agentName === "orchestrator" && (
        <div className="rounded-lg border border-border-primary bg-bg-surface p-4">
          <h3 className="mb-3 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
            Priority Queue
          </h3>

          {priorityQueue.length > 0 ? (
            <ol className="space-y-1.5">
              {priorityQueue.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-0.5 font-mono text-xs text-text-muted">
                    {i + 1}.
                  </span>
                  <span className="flex-1 truncate font-body text-xs text-text-secondary">
                    {item.task}
                  </span>
                  <span className="shrink-0 rounded bg-accent-dim px-1.5 py-0.5 font-mono text-[10px] text-accent">
                    {item.priority}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="font-body text-xs text-text-muted italic">
              No tasks in queue
            </p>
          )}
        </div>
      )}

      {/* Bottom link */}
      <Link
        href={
          agentName === "orchestrator"
            ? "/dashboard/brain"
            : "/dashboard/logs"
        }
        className="inline-block font-body text-xs text-text-muted transition-colors hover:text-accent"
      >
        {agentName === "orchestrator"
          ? "View in Brain View →"
          : "View Logs →"}
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AgentDetailPage() {
  const params = useParams();
  const agentName = params.agent as string;
  const { companyId } = useDashboard();
  const { status } = useAgentStatus(companyId, agentName);

  const Icon = ICON_MAP[agentName] ?? Brain;
  const label = LABEL_MAP[agentName] ?? agentName;
  const isRunning = status?.status === "running";

  if (!companyId) {
    return (
      <motion.div
        variants={pageTransition}
        initial="hidden"
        animate="visible"
        className="flex h-full items-center justify-center"
      >
        <p className="font-body text-sm text-text-muted">
          Select a company to start chatting.
        </p>
      </motion.div>
    );
  }

  return (
    <motion.div
      variants={pageTransition}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="flex h-[calc(100vh-56px-48px)] flex-col"
    >
      {/* Header with back nav */}
      <div className="mb-4 flex items-center gap-3">
        <Link
          href="/dashboard/agents"
          className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-bg-surface"
        >
          <ArrowLeft className="h-4 w-4 text-text-muted" />
        </Link>

        <div className="flex items-center gap-2">
          <motion.div
            variants={isRunning ? breathe : undefined}
            animate={isRunning ? "animate" : undefined}
          >
            <Icon
              className={cn(
                "h-5 w-5",
                isRunning ? "text-accent" : "text-text-secondary"
              )}
            />
          </motion.div>

          <h1 className="font-heading text-xl font-semibold text-text-primary">
            {label}
          </h1>

          {status && (
            <span
              className={cn(
                "inline-block h-2 w-2 rounded-full",
                isRunning ? "bg-accent animate-pulse" : "bg-text-muted"
              )}
            />
          )}
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[3fr_2fr]">
        {/* Chat */}
        <div className="min-h-0 overflow-hidden rounded-lg border border-border-primary bg-bg-surface">
          <ChatWindow companyId={companyId} agentName={agentName} />
        </div>

        {/* Info panel */}
        <div className="min-h-0 lg:max-h-full">
          <AgentInfoPanel agentName={agentName} companyId={companyId} />
        </div>
      </div>
    </motion.div>
  );
}
