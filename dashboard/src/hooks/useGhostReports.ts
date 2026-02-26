"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { GhostReport, Json } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useDashboard } from "@/contexts/DashboardContext";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GhostState {
  isGhostActive: boolean;
  isGhostCompleted: boolean;
  neverGhost: boolean;
  daysElapsed: number;
  daysTotal: number;
  progress: number;
}

export interface GhostTotals {
  totalHoursSaved: number;
  totalTasksAutomated: number;
  totalReports: number;
  processesObserved: number;
}

export interface UseGhostReportsReturn {
  reports: GhostReport[];
  ghostState: GhostState;
  totals: GhostTotals;
  isLoading: boolean;
  switchToActive: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function countProcesses(observed: Json): number {
  if (Array.isArray(observed)) return observed.length;
  return 0;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGhostReports(
  companyId: string | null
): UseGhostReportsReturn {
  const [reports, setReports] = useState<GhostReport[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const { company } = useDashboard();

  function getSupabase(): SupabaseClient {
    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient();
    }
    return supabaseRef.current;
  }

  useEffect(() => {
    if (!companyId || !isSupabaseConfigured()) {
      setReports([]);
      setIsLoading(false);
      return;
    }

    const supabase = getSupabase();

    async function fetchReports() {
      const { data } = await supabase
        .from("ghost_reports")
        .select("*")
        .eq("company_id", companyId)
        .order("report_date", { ascending: false });

      if (data) setReports(data as GhostReport[]);
      setIsLoading(false);
    }

    fetchReports();
  }, [companyId]);

  // -----------------------------------------------------------------------
  // Derived state
  // -----------------------------------------------------------------------

  const ghostState = useMemo((): GhostState => {
    const isGhostActive = company?.status === "ghost";
    const hasReports = reports.length > 0;
    const isGhostCompleted = !isGhostActive && hasReports;
    const neverGhost = !isGhostActive && !hasReports;

    // Determine start date
    const startDate =
      hasReports
        ? new Date(reports[reports.length - 1].report_date)
        : company?.created_at
          ? new Date(company.created_at)
          : new Date();

    const endDate = company?.ghost_mode_until
      ? new Date(company.ghost_mode_until)
      : new Date(startDate.getTime() + 7 * MS_PER_DAY);

    const now = new Date();
    const daysTotal = Math.max(
      1,
      Math.ceil((endDate.getTime() - startDate.getTime()) / MS_PER_DAY)
    );
    const daysElapsed = Math.max(
      0,
      Math.ceil((now.getTime() - startDate.getTime()) / MS_PER_DAY)
    );
    const progress = Math.min(Math.max(daysElapsed / daysTotal, 0), 1);

    return {
      isGhostActive,
      isGhostCompleted,
      neverGhost,
      daysElapsed,
      daysTotal,
      progress,
    };
  }, [company, reports]);

  const totals = useMemo((): GhostTotals => {
    let totalHours = 0;
    let totalTasks = 0;
    let totalProcesses = 0;
    for (const r of reports) {
      totalHours += r.estimated_hours_saved;
      totalTasks += r.estimated_tasks_automated;
      totalProcesses += countProcesses(r.observed_processes);
    }
    return {
      totalHoursSaved: Math.round(totalHours * 10) / 10,
      totalTasksAutomated: totalTasks,
      totalReports: reports.length,
      processesObserved: totalProcesses,
    };
  }, [reports]);

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  const switchToActive = useCallback(async () => {
    if (!companyId || !isSupabaseConfigured()) return;
    const supabase = getSupabase();

    await supabase
      .from("companies")
      .update({ status: "active" })
      .eq("id", companyId);

    await supabase.from("events").insert({
      company_id: companyId,
      event_type: "ghost_mode_ended",
      agent_name: "user",
      message: "Ghost mode ended by user — switching to active",
      severity: "info",
    });

    await supabase.from("messages").insert({
      company_id: companyId,
      sender: "system",
      content: "Ghost mode ended. System is now active.",
      message_type: "alert",
    });
  }, [companyId]);

  return { reports, ghostState, totals, isLoading, switchToActive };
}
