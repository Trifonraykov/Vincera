"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { Automation } from "@/lib/supabase";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAutomations(companyId: string | null): {
  automations: Automation[];
  isLoading: boolean;
  updateStatus: (id: string, newStatus: string) => Promise<void>;
  deleteAutomation: (id: string) => Promise<void>;
} {
  const [automations, setAutomations] = useState<Automation[]>([]);
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
      setAutomations([]);
      setIsLoading(false);
      return;
    }

    const supabase = getSupabase();

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

  // -------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------

  const updateStatus = useCallback(
    async (id: string, newStatus: string) => {
      if (!companyId || !isSupabaseConfigured()) return;
      const supabase = getSupabase();

      // Optimistic update
      setAutomations((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: newStatus } : a))
      );

      await Promise.all([
        supabase
          .from("automations")
          .update({ status: newStatus })
          .eq("id", id),
        supabase.from("events").insert({
          company_id: companyId,
          event_type: `automation_${newStatus}`,
          agent_name: "user",
          message: `Automation status changed to ${newStatus}`,
          severity: "info",
        }),
      ]);
    },
    [companyId]
  );

  const deleteAutomation = useCallback(
    async (id: string) => {
      if (!companyId || !isSupabaseConfigured()) return;
      const supabase = getSupabase();

      // Optimistic remove
      setAutomations((prev) => prev.filter((a) => a.id !== id));

      await Promise.all([
        supabase.from("automations").delete().eq("id", id),
        supabase.from("events").insert({
          company_id: companyId,
          event_type: "automation_deleted",
          agent_name: "user",
          message: "Automation deleted by user",
          severity: "warning",
        }),
      ]);
    },
    [companyId]
  );

  return { automations, isLoading, updateStatus, deleteAutomation };
}
