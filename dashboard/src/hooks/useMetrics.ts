"use client";

import { useState, useEffect, useRef } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverviewMetrics {
  hoursSaved: number;
  tasksCompleted: number;
  activeAutomations: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMetrics(companyId: string | null): {
  metrics: OverviewMetrics;
  isLoading: boolean;
} {
  const [metrics, setMetrics] = useState<OverviewMetrics>({
    hoursSaved: 0,
    tasksCompleted: 0,
    activeAutomations: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (!companyId || !isSupabaseConfigured()) {
      setMetrics({ hoursSaved: 0, tasksCompleted: 0, activeAutomations: 0 });
      setIsLoading(false);
      return;
    }

    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient();
    }
    const supabase = supabaseRef.current;

    async function fetchMetrics() {
      // Fetch hours_saved and tasks_completed from metrics table
      const { data: metricRows } = await supabase
        .from("metrics")
        .select("metric_name, metric_value")
        .eq("company_id", companyId)
        .in("metric_name", ["hours_saved", "tasks_completed"])
        .order("metric_date", { ascending: false });

      let hoursSaved = 0;
      let tasksCompleted = 0;

      if (metricRows) {
        // Take the latest value for each metric_name
        const seen = new Set<string>();
        for (const row of metricRows) {
          if (!seen.has(row.metric_name)) {
            seen.add(row.metric_name);
            if (row.metric_name === "hours_saved") hoursSaved = row.metric_value;
            if (row.metric_name === "tasks_completed") tasksCompleted = row.metric_value;
          }
        }
      }

      // Count active automations
      const { count } = await supabase
        .from("automations")
        .select("*", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("status", "active");

      setMetrics({
        hoursSaved,
        tasksCompleted,
        activeAutomations: count ?? 0,
      });
      setIsLoading(false);
    }

    fetchMetrics();

    // Realtime: metrics table + automations table
    const channel = supabase
      .channel(`overview-metrics-${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "metrics",
          filter: `company_id=eq.${companyId}`,
        },
        () => {
          fetchMetrics();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "automations",
          filter: `company_id=eq.${companyId}`,
        },
        () => {
          fetchMetrics();
        }
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [companyId]);

  return { metrics, isLoading };
}
