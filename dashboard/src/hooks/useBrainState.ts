"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { BrainState, Json } from "@/lib/supabase";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Safe JSONB helpers — never crash on malformed data
// ---------------------------------------------------------------------------

type JsonObj = Record<string, Json>;

function asObj(val: Json): JsonObj | null {
  if (val && typeof val === "object" && !Array.isArray(val)) return val as JsonObj;
  return null;
}

export function getStr(state: Json, key: string): string | null {
  const obj = asObj(state);
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

export function getNum(state: Json, key: string): number | null {
  const obj = asObj(state);
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "number" ? v : null;
}

export function getObj(state: Json, key: string): Json | null {
  const obj = asObj(state);
  if (!obj) return null;
  return obj[key] ?? null;
}

export type OodaPhase =
  | "observing"
  | "orienting"
  | "deciding"
  | "acting"
  | "learning"
  | "idle";

export function getPhase(state: Json): OodaPhase {
  const raw = getStr(state, "ooda_phase");
  if (
    raw === "observing" ||
    raw === "orienting" ||
    raw === "deciding" ||
    raw === "acting" ||
    raw === "learning"
  )
    return raw;
  return "idle";
}

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------

export interface UseBrainStateReturn {
  current: BrainState | null;
  history: BrainState[];
  selectedCycle: BrainState | null;
  selectCycle: (cycleNumber: number) => void;
  clearSelection: () => void;
  isLoading: boolean;
  isLive: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useBrainState(companyId: string | null): UseBrainStateReturn {
  const [current, setCurrent] = useState<BrainState | null>(null);
  const [history, setHistory] = useState<BrainState[]>([]);
  const [selectedCycle, setSelectedCycle] = useState<BrainState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Whether we are viewing the live state (no cycle selected)
  const isLive = selectedCycle === null;

  // -------------------------------------------------------------------
  // Select / clear a historical cycle
  // -------------------------------------------------------------------

  const selectCycle = useCallback(
    async (cycleNumber: number) => {
      if (!companyId || !isSupabaseConfigured()) return;
      if (!supabaseRef.current) {
        supabaseRef.current = createBrowserClient();
      }
      const supabase = supabaseRef.current;

      // Filter client-side for the cycle (state->cycle_number)
      // Since we can't filter JSONB easily via PostgREST, fetch recent and find it
      const { data: cycleRows } = await supabase
        .from("brain_states")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(200);

      if (cycleRows) {
        // Find rows matching this cycle number, take the latest (last phase)
        const matching = (cycleRows as BrainState[]).filter(
          (row) => getNum(row.state, "cycle_number") === cycleNumber
        );
        if (matching.length > 0) {
          setSelectedCycle(matching[0]); // Already sorted desc by created_at
        }
      }
    },
    [companyId]
  );

  const clearSelection = useCallback(() => {
    setSelectedCycle(null);
  }, []);

  // -------------------------------------------------------------------
  // Fetch current + history, subscribe to Realtime
  // -------------------------------------------------------------------

  useEffect(() => {
    if (!companyId || !isSupabaseConfigured()) {
      setCurrent(null);
      setHistory([]);
      setIsLoading(false);
      return;
    }

    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient();
    }
    const supabase = supabaseRef.current;

    async function fetchData() {
      // Fetch latest brain_state (current)
      const { data: latestRows } = await supabase
        .from("brain_states")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (latestRows && latestRows.length > 0) {
        setCurrent(latestRows[0] as BrainState);
      }

      // Fetch last ~200 rows, then deduplicate by cycle_number client-side
      // (keeping the latest row per cycle = final phase)
      const { data: historyRows } = await supabase
        .from("brain_states")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(200);

      if (historyRows) {
        const seen = new Set<number>();
        const deduped: BrainState[] = [];
        for (const row of historyRows as BrainState[]) {
          const cn = getNum(row.state, "cycle_number");
          if (cn !== null && !seen.has(cn)) {
            seen.add(cn);
            deduped.push(row);
          }
        }
        // Keep last 50 cycles, reversed to chronological order (oldest first)
        setHistory(deduped.slice(0, 50).reverse());
      }

      setIsLoading(false);
    }

    fetchData();

    // Realtime: brain_states INSERTs
    const channel = supabase
      .channel(`brain-${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "brain_states",
          filter: `company_id=eq.${companyId}`,
        },
        (payload) => {
          const newRow = payload.new as BrainState;
          setCurrent(newRow);

          // Update history
          const newCycleNum = getNum(newRow.state, "cycle_number");
          setHistory((prev) => {
            if (newCycleNum === null) return prev;
            // Check if this cycle already exists in history
            const idx = prev.findIndex(
              (h) => getNum(h.state, "cycle_number") === newCycleNum
            );
            if (idx >= 0) {
              // Update existing cycle entry with latest phase
              const updated = [...prev];
              updated[idx] = newRow;
              return updated;
            }
            // New cycle — append and cap at 50
            const appended = [...prev, newRow];
            if (appended.length > 50) appended.shift();
            return appended;
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

  return {
    current,
    history,
    selectedCycle,
    selectCycle,
    clearSelection,
    isLoading,
    isLive,
  };
}
