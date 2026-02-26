"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type {
  AgentStatus,
  Automation,
  Metric,
  ResearchSource,
  ResearchInsight,
} from "@/lib/supabase";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseCompanyProfileReturn {
  agentStatuses: AgentStatus[];
  automations: Automation[];
  metrics: Metric[];
  researchSources: ResearchSource[];
  researchInsights: ResearchInsight[];
  totalHoursSaved: number;
  isLoading: boolean;
  updateAutomationStatus: (id: string, status: string) => Promise<void>;
  deleteAutomation: (id: string) => Promise<void>;
  exportData: (companyName: string) => Promise<void>;
  disconnect: (companyId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCompanyProfile(
  companyId: string | null
): UseCompanyProfileReturn {
  const [agentStatuses, setAgentStatuses] = useState<AgentStatus[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [researchSources, setResearchSources] = useState<ResearchSource[]>([]);
  const [researchInsights, setResearchInsights] = useState<ResearchInsight[]>(
    []
  );
  const [isLoading, setIsLoading] = useState(true);

  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  function getSupabase(): SupabaseClient {
    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient();
    }
    return supabaseRef.current;
  }

  useEffect(() => {
    if (!companyId || !isSupabaseConfigured()) {
      setAgentStatuses([]);
      setAutomations([]);
      setMetrics([]);
      setResearchSources([]);
      setResearchInsights([]);
      setIsLoading(false);
      return;
    }

    const supabase = getSupabase();

    async function fetchAll() {
      const [agentsRes, autoRes, metricsRes, sourcesRes, insightsRes] =
        await Promise.all([
          supabase
            .from("agent_statuses")
            .select("*")
            .eq("company_id", companyId),
          supabase
            .from("automations")
            .select("*")
            .eq("company_id", companyId)
            .order("updated_at", { ascending: false }),
          supabase
            .from("metrics")
            .select("*")
            .eq("company_id", companyId)
            .order("metric_date", { ascending: true }),
          supabase
            .from("research_sources")
            .select("*")
            .eq("company_id", companyId)
            .order("relevance_score", { ascending: false }),
          supabase
            .from("research_insights")
            .select("*")
            .eq("company_id", companyId),
        ]);

      if (agentsRes.data) setAgentStatuses(agentsRes.data as AgentStatus[]);
      if (autoRes.data) setAutomations(autoRes.data as Automation[]);
      if (metricsRes.data) setMetrics(metricsRes.data as Metric[]);
      if (sourcesRes.data)
        setResearchSources(sourcesRes.data as ResearchSource[]);
      if (insightsRes.data)
        setResearchInsights(insightsRes.data as ResearchInsight[]);
      setIsLoading(false);
    }

    fetchAll();

    // Realtime for agent statuses
    const channel = supabase
      .channel(`company-profile-agents-${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_statuses",
          filter: `company_id=eq.${companyId}`,
        },
        () => {
          supabase
            .from("agent_statuses")
            .select("*")
            .eq("company_id", companyId)
            .then(({ data }) => {
              if (data) setAgentStatuses(data as AgentStatus[]);
            });
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

  // Derived
  const totalHoursSaved = metrics
    .filter((m) => m.metric_name === "hours_saved")
    .reduce((sum, m) => sum + m.metric_value, 0);

  // Actions
  const updateAutomationStatus = useCallback(
    async (id: string, newStatus: string) => {
      if (!companyId || !isSupabaseConfigured()) return;
      const supabase = getSupabase();
      setAutomations((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: newStatus } : a))
      );
      await supabase
        .from("automations")
        .update({ status: newStatus })
        .eq("id", id);
    },
    [companyId]
  );

  const deleteAutomation = useCallback(
    async (id: string) => {
      if (!companyId || !isSupabaseConfigured()) return;
      const supabase = getSupabase();
      setAutomations((prev) => prev.filter((a) => a.id !== id));
      await supabase.from("automations").delete().eq("id", id);
    },
    [companyId]
  );

  const exportData = useCallback(
    async (companyName: string) => {
      if (!companyId || !isSupabaseConfigured()) return;
      const supabase = getSupabase();

      const [knowledgeRes, eventsRes, messagesRes, decisionsRes] =
        await Promise.all([
          supabase
            .from("company_knowledge")
            .select("*")
            .eq("company_id", companyId),
          supabase.from("events").select("*").eq("company_id", companyId),
          supabase.from("messages").select("*").eq("company_id", companyId),
          supabase.from("decisions").select("*").eq("company_id", companyId),
        ]);

      const exportObj = {
        exported_at: new Date().toISOString(),
        company_id: companyId,
        agents: agentStatuses,
        automations,
        metrics,
        research_sources: researchSources,
        research_insights: researchInsights,
        knowledge: knowledgeRes.data ?? [],
        events: eventsRes.data ?? [],
        messages: messagesRes.data ?? [],
        decisions: decisionsRes.data ?? [],
      };

      const blob = new Blob([JSON.stringify(exportObj, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `vincera-export-${companyName.toLowerCase().replace(/\s+/g, "-")}-${date}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [
      companyId,
      agentStatuses,
      automations,
      metrics,
      researchSources,
      researchInsights,
    ]
  );

  const disconnect = useCallback(
    async (cId: string) => {
      if (!isSupabaseConfigured()) return;
      const supabase = getSupabase();

      await supabase
        .from("companies")
        .update({ status: "disconnected" })
        .eq("id", cId);

      await supabase.from("events").insert({
        company_id: cId,
        event_type: "company_disconnected",
        agent_name: "user",
        message: "Company disconnected by user",
        severity: "warning",
      });

      await supabase.from("messages").insert({
        company_id: cId,
        sender: "system",
        content:
          "Company disconnected. All agents and automations have been stopped.",
        message_type: "alert",
      });
    },
    []
  );

  return {
    agentStatuses,
    automations,
    metrics,
    researchSources,
    researchInsights,
    totalHoursSaved,
    isLoading,
    updateAutomationStatus,
    deleteAutomation,
    exportData,
    disconnect,
  };
}
