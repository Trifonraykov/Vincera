"use client";

import { useState, useEffect, useRef } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { Automation } from "@/lib/supabase";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAutomations(companyId: string | null): {
  automations: Automation[];
  isLoading: boolean;
} {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (!companyId || !isSupabaseConfigured()) {
      setAutomations([]);
      setIsLoading(false);
      return;
    }

    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient();
    }
    const supabase = supabaseRef.current;

    async function fetchAutomations() {
      const { data } = await supabase
        .from("automations")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false });
      if (data) setAutomations(data as Automation[]);
      setIsLoading(false);
    }

    fetchAutomations();

    // Realtime: automations changes
    const channel = supabase
      .channel(`overview-automations-${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "automations",
          filter: `company_id=eq.${companyId}`,
        },
        () => {
          fetchAutomations();
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

  return { automations, isLoading };
}
