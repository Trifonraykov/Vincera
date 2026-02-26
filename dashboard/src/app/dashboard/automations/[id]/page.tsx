"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  ChevronUp,
  Pause,
  Play,
  Undo2,
  Trash2,
  RefreshCw,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { pageTransition } from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { Automation, Json } from "@/lib/supabase";
import { cn, timeAgo, formatNumber } from "@/lib/utils";
import ShadowReport from "@/components/automations/ShadowReport";
import ConfirmModal from "@/components/ui/ConfirmModal";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonObj = Record<string, Json>;

function getHoursSaved(a: Automation): number {
  const meta = a.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const obj = meta as JsonObj;
    if (typeof obj.hours_saved_total === "number") return obj.hours_saved_total;
    if (typeof obj.hours_saved === "number") return obj.hours_saved;
  }
  return 0;
}

function successRate(a: Automation): number | null {
  if (a.run_count === 0) return null;
  return (a.success_count / a.run_count) * 100;
}

function statusDot(status: string) {
  switch (status) {
    case "active":
      return { dot: "bg-accent", text: "text-accent", label: "active" };
    case "shadow":
      return { dot: "border border-[#4488FF] bg-transparent", text: "text-[#4488FF]", label: "shadow" };
    case "canary":
      return { dot: "bg-accent/50", text: "text-accent/80", label: "canary" };
    case "paused":
      return { dot: "bg-warning", text: "text-warning", label: "paused" };
    case "failed":
      return { dot: "bg-error", text: "text-error", label: "failed" };
    case "retired":
      return { dot: "bg-text-muted/40", text: "text-text-muted", label: "retired" };
    default:
      return { dot: "bg-text-muted/40", text: "text-text-muted", label: status };
  }
}

const NEXT_STAGE: Record<string, string> = {
  shadow: "canary",
  canary: "active",
};

const PREV_STAGE: Record<string, string> = {
  active: "canary",
  canary: "shadow",
};

// ---------------------------------------------------------------------------
// Run history mock data from metadata
// ---------------------------------------------------------------------------

function getRunHistory(a: Automation): { run: number; rate: number }[] {
  const meta = a.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const obj = meta as JsonObj;
    const history = obj.run_history;
    if (Array.isArray(history)) {
      return history.map((h, i) => {
        if (h && typeof h === "object" && !Array.isArray(h)) {
          const item = h as JsonObj;
          return {
            run: i + 1,
            rate: typeof item.success_rate === "number" ? item.success_rate : 0,
          };
        }
        return { run: i + 1, rate: 0 };
      });
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AutomationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const automationId = params.id as string;
  const { companyId } = useDashboard();

  const [automation, setAutomation] = useState<Automation | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    action: () => Promise<void>;
    variant: "accent" | "danger";
    label: string;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Fetch automation
  useEffect(() => {
    if (!automationId || !companyId || !isSupabaseConfigured()) {
      setIsLoading(false);
      return;
    }
    const supabase = createBrowserClient();
    async function fetch() {
      const { data } = await supabase
        .from("automations")
        .select("*")
        .eq("id", automationId)
        .single();
      if (data) setAutomation(data as Automation);
      setIsLoading(false);
    }
    fetch();
  }, [automationId, companyId]);

  // Actions
  async function updateStatus(newStatus: string) {
    if (!automation || !companyId || !isSupabaseConfigured()) return;
    const supabase = createBrowserClient();
    setAutomation((prev) => (prev ? { ...prev, status: newStatus } : prev));
    await Promise.all([
      supabase
        .from("automations")
        .update({ status: newStatus })
        .eq("id", automation.id),
      supabase.from("events").insert({
        company_id: companyId,
        event_type: `automation_${newStatus}`,
        agent_name: "user",
        message: `${automation.name} status changed to ${newStatus}`,
        severity: "info",
      }),
    ]);
  }

  async function handleDelete() {
    if (!automation || !companyId || !isSupabaseConfigured()) return;
    const supabase = createBrowserClient();
    await supabase.from("automations").delete().eq("id", automation.id);
    router.push("/dashboard/automations");
  }

  function openPromote() {
    if (!automation) return;
    const next = NEXT_STAGE[automation.status];
    if (!next) return;
    setConfirmAction({
      title: `Promote to ${next}?`,
      description: `"${automation.name}" will be promoted from ${automation.status} to ${next}.`,
      action: () => updateStatus(next),
      variant: "accent",
      label: `Promote to ${next}`,
    });
  }

  function openDelete() {
    if (!automation) return;
    setConfirmAction({
      title: "Delete automation?",
      description: `"${automation.name}" will be permanently deleted.`,
      action: handleDelete,
      variant: "danger",
      label: "Delete",
    });
  }

  async function runConfirm() {
    if (!confirmAction) return;
    setActionLoading(true);
    await confirmAction.action();
    setActionLoading(false);
    setConfirmAction(null);
  }

  if (isLoading) {
    return (
      <motion.div
        variants={pageTransition}
        initial="hidden"
        animate="visible"
        className="flex h-64 items-center justify-center"
      >
        <span className="font-mono text-sm text-text-muted">Loading...</span>
      </motion.div>
    );
  }

  if (!automation) {
    return (
      <motion.div
        variants={pageTransition}
        initial="hidden"
        animate="visible"
        className="flex h-64 items-center justify-center"
      >
        <span className="font-body text-sm text-text-muted">
          Automation not found.
        </span>
      </motion.div>
    );
  }

  const sd = statusDot(automation.status);
  const rate = successRate(automation);
  const hours = getHoursSaved(automation);
  const runHistory = getRunHistory(automation);
  const canPromote = !!NEXT_STAGE[automation.status];
  const canRollback = !!PREV_STAGE[automation.status];

  return (
    <motion.div
      variants={pageTransition}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {/* Breadcrumb */}
      <div className="mb-6 flex items-center gap-2">
        <Link
          href="/dashboard/automations"
          className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-bg-surface"
        >
          <ArrowLeft className="h-4 w-4 text-text-muted" />
        </Link>
        <span className="font-body text-sm text-text-muted">
          Automations /
        </span>
        <h1 className="font-heading text-xl font-semibold text-text-primary">
          {automation.name}
        </h1>
      </div>

      {/* Status & Actions row */}
      <div className="mb-6 grid gap-4 lg:grid-cols-[2fr_1fr]">
        {/* Status & Info */}
        <div className="rounded-lg border border-border-primary bg-bg-surface p-5">
          <div className="mb-3 flex items-center gap-3">
            <span className={cn("inline-block h-2.5 w-2.5 rounded-full", sd.dot)} />
            <span className={cn("font-body text-sm font-medium", sd.text)}>
              {sd.label}
            </span>
            {automation.schedule && (
              <span className="font-mono text-xs text-text-muted">
                · {automation.schedule}
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-6 font-mono text-xs">
            {rate !== null && (
              <div>
                <p className="mb-0.5 font-body text-[10px] text-text-muted uppercase tracking-widest">
                  Success
                </p>
                <span
                  className={cn(
                    rate >= 90
                      ? "text-accent"
                      : rate >= 70
                        ? "text-warning"
                        : "text-error"
                  )}
                >
                  {rate.toFixed(1)}%
                </span>
              </div>
            )}
            {hours > 0 && (
              <div>
                <p className="mb-0.5 font-body text-[10px] text-text-muted uppercase tracking-widest">
                  Hours Saved
                </p>
                <span className="text-text-secondary">
                  {formatNumber(hours)}h
                </span>
              </div>
            )}
            <div>
              <p className="mb-0.5 font-body text-[10px] text-text-muted uppercase tracking-widest">
                Runs
              </p>
              <span className="text-text-secondary">{automation.run_count}</span>
            </div>
            <div>
              <p className="mb-0.5 font-body text-[10px] text-text-muted uppercase tracking-widest">
                Created
              </p>
              <span className="text-text-muted">
                {timeAgo(automation.created_at)}
              </span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="rounded-lg border border-border-primary bg-bg-surface p-5">
          <h3 className="mb-3 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
            Actions
          </h3>
          <div className="flex flex-wrap gap-2">
            {canPromote && (
              <button
                onClick={openPromote}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 font-body text-xs font-medium text-black transition-opacity hover:opacity-90"
              >
                <ChevronUp className="h-3.5 w-3.5" />
                Promote to {NEXT_STAGE[automation.status]}
              </button>
            )}
            {automation.status === "active" && (
              <button
                onClick={() => updateStatus("paused")}
                className="flex items-center gap-1.5 rounded-md border border-warning px-3 py-2 font-body text-xs font-medium text-warning transition-colors hover:bg-warning/10"
              >
                <Pause className="h-3.5 w-3.5" />
                Pause
              </button>
            )}
            {automation.status === "paused" && (
              <button
                onClick={() => updateStatus("active")}
                className="flex items-center gap-1.5 rounded-md border border-warning px-3 py-2 font-body text-xs font-medium text-warning transition-colors hover:bg-warning/10"
              >
                <Play className="h-3.5 w-3.5" />
                Resume
              </button>
            )}
            {canRollback && (
              <button
                onClick={() =>
                  updateStatus(PREV_STAGE[automation.status])
                }
                className="flex items-center gap-1.5 rounded-md border border-border-primary px-3 py-2 font-body text-xs font-medium text-text-secondary transition-colors hover:bg-bg-surface-raised"
              >
                <Undo2 className="h-3.5 w-3.5" />
                Rollback
              </button>
            )}
            {automation.status === "failed" && (
              <button
                onClick={() => updateStatus("active")}
                className="flex items-center gap-1.5 rounded-md border border-accent px-3 py-2 font-body text-xs font-medium text-accent transition-colors hover:bg-accent/10"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </button>
            )}
            {(automation.status === "shadow" ||
              automation.status === "paused" ||
              automation.status === "failed") && (
              <button
                onClick={openDelete}
                className="flex items-center gap-1.5 rounded-md border border-error/50 px-3 py-2 font-body text-xs font-medium text-error transition-colors hover:bg-error/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      {automation.description && (
        <div className="mb-6 rounded-lg border border-border-primary bg-bg-surface p-5">
          <h3 className="mb-2 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
            Description
          </h3>
          <p className="font-body text-sm leading-relaxed text-text-secondary">
            {automation.description}
          </p>
        </div>
      )}

      {/* Shadow Report */}
      {(automation.status === "shadow" || automation.status === "canary" || automation.shadow_result) && (
        <div className="mb-6">
          <ShadowReport report={automation.shadow_result} />
        </div>
      )}

      {/* Run History Chart */}
      <div className="mb-6 rounded-lg border border-border-primary bg-bg-surface p-5">
        <h3 className="mb-3 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
          Run History
        </h3>
        {runHistory.length > 0 ? (
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={runHistory}>
              <defs>
                <linearGradient id="rateGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00FF88" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#00FF88" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="run"
                tick={{ fill: "#555", fontSize: 10, fontFamily: "monospace" }}
                axisLine={{ stroke: "#1A1A1A" }}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fill: "#555", fontSize: 10, fontFamily: "monospace" }}
                axisLine={false}
                tickLine={false}
                width={30}
              />
              <Tooltip
                contentStyle={{
                  background: "#111",
                  border: "1px solid #1A1A1A",
                  borderRadius: 6,
                  fontSize: 11,
                  fontFamily: "monospace",
                }}
                labelStyle={{ color: "#888" }}
                itemStyle={{ color: "#00FF88" }}
              />
              <Area
                type="monotone"
                dataKey="rate"
                stroke="#00FF88"
                fill="url(#rateGrad)"
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <p className="py-6 text-center font-body text-xs text-text-muted italic">
            Run history will appear after more executions.
          </p>
        )}
      </div>

      {/* Promote section */}
      {canPromote && (
        <div className="rounded-lg border border-border-primary bg-bg-surface p-5">
          <h3 className="mb-2 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
            Lifecycle
          </h3>
          <div className="mb-3 flex items-center gap-3 font-mono text-xs">
            {["shadow", "canary", "active"].map((stage, i) => (
              <span key={stage} className="flex items-center gap-2">
                {i > 0 && <span className="text-text-muted">&rarr;</span>}
                <span
                  className={cn(
                    automation.status === stage
                      ? "font-medium text-accent"
                      : "text-text-muted"
                  )}
                >
                  {stage}
                </span>
              </span>
            ))}
          </div>
          <button
            onClick={openPromote}
            className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 font-body text-sm font-medium text-black transition-opacity hover:opacity-90"
          >
            <ChevronUp className="h-4 w-4" />
            Promote to {NEXT_STAGE[automation.status]}
          </button>
        </div>
      )}

      {/* Confirm modal */}
      <ConfirmModal
        isOpen={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        onConfirm={runConfirm}
        title={confirmAction?.title ?? ""}
        description={confirmAction?.description ?? ""}
        confirmLabel={confirmAction?.label}
        confirmVariant={confirmAction?.variant}
        isLoading={actionLoading}
      />
    </motion.div>
  );
}
