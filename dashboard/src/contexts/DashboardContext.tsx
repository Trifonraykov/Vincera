"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { Company, AgentStatus } from "@/lib/supabase";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentSummary {
  total: number;
  running: number;
  idle: number;
  failed: number;
}

interface DashboardContextType {
  companyId: string | null;
  setCompanyId: (id: string) => void;
  company: Company | null;
  isPaused: boolean;
  togglePause: () => Promise<void>;
  agentSummary: AgentSummary;
  agentStatuses: AgentStatus[];
  pendingDecisions: number;
  isConnected: boolean;
}

const DashboardContext = createContext<DashboardContextType | null>(null);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDashboard(): DashboardContextType {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard must be used within DashboardProvider");
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function DashboardProvider({ children }: { children: ReactNode }) {
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelsRef = useRef<RealtimeChannel[]>([]);

  const [companyId, setCompanyIdState] = useState<string | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<AgentStatus[]>([]);
  const [pendingDecisions, setPendingDecisions] = useState(0);
  const [isConnected, setIsConnected] = useState(false);

  // Lazy-init supabase client
  function getSupabase(): SupabaseClient {
    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient();
    }
    return supabaseRef.current;
  }

  // Persist companyId to localStorage
  const setCompanyId = useCallback((id: string) => {
    setCompanyIdState(id);
    try {
      localStorage.setItem("vincera-company-id", id);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  // Restore companyId from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem("vincera-company-id");
      if (stored) setCompanyIdState(stored);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Fetch company + subscribe to changes
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!companyId || !isSupabaseConfigured()) {
      setCompany(null);
      setAgentStatuses([]);
      setPendingDecisions(0);
      return;
    }

    const supabase = getSupabase();

    // Clean up previous subscriptions
    channelsRef.current.forEach((ch) => supabase.removeChannel(ch));
    channelsRef.current = [];

    // Fetch company
    async function fetchCompany() {
      const { data } = await supabase
        .from("companies")
        .select("*")
        .eq("id", companyId)
        .single();
      if (data) setCompany(data as Company);
    }

    // Fetch agent statuses
    async function fetchAgents() {
      const { data } = await supabase
        .from("agent_statuses")
        .select("*")
        .eq("company_id", companyId);
      if (data) setAgentStatuses(data as AgentStatus[]);
    }

    // Fetch pending decisions count
    async function fetchDecisions() {
      const { count } = await supabase
        .from("decisions")
        .select("*", { count: "exact", head: true })
        .eq("company_id", companyId)
        .is("resolution", null);
      setPendingDecisions(count ?? 0);
    }

    fetchCompany();
    fetchAgents();
    fetchDecisions();

    // Realtime: company changes
    const companyChannel = supabase
      .channel(`company-${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "companies",
          filter: `id=eq.${companyId}`,
        },
        (payload) => {
          if (payload.new) setCompany(payload.new as Company);
        }
      )
      .subscribe((status) => {
        setIsConnected(status === "SUBSCRIBED");
      });

    // Realtime: agent_statuses changes
    const agentsChannel = supabase
      .channel(`agents-${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_statuses",
          filter: `company_id=eq.${companyId}`,
        },
        () => {
          // Re-fetch all statuses on any change for simplicity
          fetchAgents();
        }
      )
      .subscribe();

    // Realtime: decisions changes
    const decisionsChannel = supabase
      .channel(`decisions-${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "decisions",
          filter: `company_id=eq.${companyId}`,
        },
        () => {
          fetchDecisions();
        }
      )
      .subscribe();

    channelsRef.current = [companyChannel, agentsChannel, decisionsChannel];

    return () => {
      channelsRef.current.forEach((ch) => supabase.removeChannel(ch));
      channelsRef.current = [];
    };
  }, [companyId]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const isPaused = company?.status === "paused";

  const agentSummary: AgentSummary = {
    total: agentStatuses.length,
    running: agentStatuses.filter((a) => a.status === "running").length,
    idle: agentStatuses.filter((a) => a.status === "idle").length,
    failed: agentStatuses.filter((a) => a.status === "failed").length,
  };

  // ---------------------------------------------------------------------------
  // Toggle pause
  // ---------------------------------------------------------------------------

  const togglePause = useCallback(async () => {
    if (!companyId) return;
    if (!isSupabaseConfigured()) {
      // Toggle locally even without Supabase
      const newStatus = isPaused ? "active" : "paused";
      setCompany((prev) => (prev ? { ...prev, status: newStatus } : prev));
      return;
    }
    const supabase = getSupabase();
    const newStatus = isPaused ? "active" : "paused";
    const actionLabel = isPaused ? "resumed" : "paused";

    // Optimistic update
    setCompany((prev) => (prev ? { ...prev, status: newStatus } : prev));

    // Write to Supabase in parallel
    await Promise.all([
      supabase
        .from("companies")
        .update({ status: newStatus })
        .eq("id", companyId),
      supabase.from("messages").insert({
        company_id: companyId,
        sender: "system",
        content: `System ${actionLabel} by user`,
        message_type: "alert",
      }),
      supabase.from("events").insert({
        company_id: companyId,
        event_type: `system_${actionLabel}`,
        agent_name: "system",
        message: `System ${actionLabel} by user`,
        severity: "warning",
      }),
    ]);
  }, [companyId, isPaused]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <DashboardContext.Provider
      value={{
        companyId,
        setCompanyId,
        company,
        isPaused,
        togglePause,
        agentSummary,
        agentStatuses,
        pendingDecisions,
        isConnected,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
}
