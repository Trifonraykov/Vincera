"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { Decision } from "@/lib/supabase";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseDecisionsReturn {
  pending: Decision[];
  resolved: Decision[];
  pendingCount: number;
  resolvedCount: number;
  approve: (id: string, chosenOption: string, note?: string) => Promise<void>;
  reject: (id: string, reason?: string) => Promise<void>;
  isLoading: boolean;
}

export function useDecisions(companyId: string | null): UseDecisionsReturn {
  const [pending, setPending] = useState<Decision[]>([]);
  const [resolved, setResolved] = useState<Decision[]>([]);
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
      setPending([]);
      setResolved([]);
      setIsLoading(false);
      return;
    }

    const supabase = getSupabase();

    async function fetchDecisions() {
      const { data } = await supabase
        .from("decisions")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false });

      if (data) {
        const decisions = data as Decision[];
        setPending(decisions.filter((d) => d.resolution === null));
        setResolved(
          decisions
            .filter((d) => d.resolution !== null)
            .sort(
              (a, b) =>
                new Date(b.resolved_at ?? b.created_at).getTime() -
                new Date(a.resolved_at ?? a.created_at).getTime()
            )
        );
      }
      setIsLoading(false);
    }

    fetchDecisions();

    // Realtime
    const channel = supabase
      .channel(`decisions-page-${companyId}`)
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

  const approve = useCallback(
    async (id: string, chosenOption: string, note?: string) => {
      if (!companyId || !isSupabaseConfigured()) return;
      const supabase = getSupabase();

      // Optimistic: move from pending to resolved
      setPending((prev) => prev.filter((d) => d.id !== id));
      setResolved((prev) => {
        const decision = pending.find((d) => d.id === id);
        if (!decision) return prev;
        return [
          {
            ...decision,
            resolution: "approved",
            resolved_at: new Date().toISOString(),
            metadata: {
              ...(typeof decision.metadata === "object" && decision.metadata && !Array.isArray(decision.metadata)
                ? decision.metadata
                : {}),
              chosen_option: chosenOption,
              note: note || null,
            },
          },
          ...prev,
        ];
      });

      await supabase
        .from("decisions")
        .update({
          resolution: "approved",
          resolved_at: new Date().toISOString(),
          metadata: { chosen_option: chosenOption, note: note || null },
        })
        .eq("id", id);

      await supabase.from("events").insert({
        company_id: companyId,
        event_type: "decision_approved",
        agent_name: "user",
        message: `Decision approved (option ${chosenOption})`,
        severity: "info",
      });
    },
    [companyId, pending]
  );

  const reject = useCallback(
    async (id: string, reason?: string) => {
      if (!companyId || !isSupabaseConfigured()) return;
      const supabase = getSupabase();

      const decision = pending.find((d) => d.id === id);

      // Optimistic
      setPending((prev) => prev.filter((d) => d.id !== id));
      setResolved((prev) => {
        if (!decision) return prev;
        return [
          {
            ...decision,
            resolution: "rejected",
            resolved_at: new Date().toISOString(),
          },
          ...prev,
        ];
      });

      await supabase
        .from("decisions")
        .update({
          resolution: "rejected",
          resolved_at: new Date().toISOString(),
        })
        .eq("id", id);

      await supabase.from("events").insert({
        company_id: companyId,
        event_type: "decision_rejected",
        agent_name: "user",
        message: `Decision rejected${reason ? `: ${reason}` : ""}`,
        severity: "info",
      });

      // Insert correction so the Trainer agent can learn
      if (decision) {
        await supabase.from("corrections").insert({
          company_id: companyId,
          agent_name: decision.agent_name,
          original_action: JSON.stringify({
            question: decision.question,
            option_a: decision.option_a,
            option_b: decision.option_b,
          }),
          correction_text: reason || "Decision rejected by user",
          category: "decision_rejected",
          severity: "medium",
          applied: false,
        });
      }
    },
    [companyId, pending]
  );

  return {
    pending,
    resolved,
    pendingCount: pending.length,
    resolvedCount: resolved.length,
    approve,
    reject,
    isLoading,
  };
}
