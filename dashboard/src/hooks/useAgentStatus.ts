"use client";

import { useState, useEffect, useRef } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { AgentStatus } from "@/lib/supabase";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

export interface UseAgentStatusReturn {
  status: AgentStatus | null;
  isLoading: boolean;
}

export function useAgentStatus(
  companyId: string | null,
  agentName: string
): UseAgentStatusReturn {
  const [status, setStatus] = useState<AgentStatus | null>(null);
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
    if (!companyId || !agentName || !isSupabaseConfigured()) {
      setStatus(null);
      setIsLoading(false);
      return;
    }

    const supabase = getSupabase();
    setIsLoading(true);

    async function fetch() {
      const { data } = await supabase
        .from("agent_statuses")
        .select("*")
        .eq("company_id", companyId)
        .eq("agent_name", agentName)
        .single();
      setStatus(data as AgentStatus | null);
      setIsLoading(false);
    }

    fetch();

    const channel = supabase
      .channel(`agent-status-${companyId}-${agentName}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_statuses",
          filter: `company_id=eq.${companyId}`,
        },
        (payload) => {
          const row = payload.new as AgentStatus;
          if (row.agent_name === agentName) {
            setStatus(row);
          }
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
  }, [companyId, agentName]);

  return { status, isLoading };
}
