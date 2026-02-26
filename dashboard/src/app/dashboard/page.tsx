"use client";

import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Clock, CheckCircle, Cog, AlertTriangle } from "lucide-react";
import {
  pageTransition,
  staggerChildren,
} from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import { useMetrics } from "@/hooks/useMetrics";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useAutomations } from "@/hooks/useAutomations";
import MetricCard from "@/components/metrics/MetricCard";
import AgentGridCard from "@/components/agents/AgentGridCard";
import ActivityFeed from "@/components/activity/ActivityFeed";
import HealthBar from "@/components/automations/HealthBar";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OverviewPage() {
  const router = useRouter();
  const { companyId, agentStatuses, pendingDecisions } = useDashboard();
  const { metrics } = useMetrics(companyId);
  const { items: feedItems, isLoading: feedLoading } =
    useActivityFeed(companyId);
  const { automations, isLoading: automationsLoading } =
    useAutomations(companyId);

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
          Overview
        </h1>
        <p className="mt-1 font-body text-sm text-text-secondary">
          System health at a glance.
        </p>
      </div>

      {/* Metric cards */}
      <motion.div
        variants={staggerChildren(0.08)}
        initial="hidden"
        animate="visible"
        className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4"
      >
        <MetricCard
          label="Hours Saved"
          value={metrics.hoursSaved}
          suffix="h"
          icon={Clock}
        />
        <MetricCard
          label="Tasks Completed"
          value={metrics.tasksCompleted}
          icon={CheckCircle}
        />
        <MetricCard
          label="Active Automations"
          value={metrics.activeAutomations}
          icon={Cog}
        />
        <MetricCard
          label="Pending Decisions"
          value={pendingDecisions}
          icon={AlertTriangle}
          pulse
          onClick={() => router.push("/dashboard/decisions")}
        />
      </motion.div>

      {/* Agent grid + Activity feed */}
      <div className="mb-6 grid min-h-0 gap-4 lg:grid-cols-[3fr_2fr]">
        <AgentGridCard statuses={agentStatuses} />
        <ActivityFeed items={feedItems} isLoading={feedLoading} />
      </div>

      {/* Health bar */}
      <HealthBar automations={automations} isLoading={automationsLoading} />
    </motion.div>
  );
}
