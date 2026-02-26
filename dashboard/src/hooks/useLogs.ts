"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { Event } from "@/lib/supabase";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogFilters {
  agent: string | null;
  eventType: string | null;
  severity: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  search: string;
}

export interface UseLogsReturn {
  events: Event[];
  isLoading: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  filters: LogFilters;
  setFilters: (f: Partial<LogFilters>) => void;
  exportCSV: (companyName: string) => void;
}

const PAGE_SIZE = 100;
const LOAD_MORE_SIZE = 50;
const MAX_EVENTS = 500;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useLogs(companyId: string | null): UseLogsReturn {
  const [events, setEvents] = useState<Event[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [filters, setFiltersState] = useState<LogFilters>({
    agent: null,
    eventType: null,
    severity: null,
    dateFrom: null,
    dateTo: null,
    search: "",
  });

  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  function getSupabase(): SupabaseClient {
    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient();
    }
    return supabaseRef.current;
  }

  // Build query with filters
  function buildQuery(supabase: SupabaseClient, limit: number, cursor?: string) {
    let q = supabase
      .from("events")
      .select("*")
      .eq("company_id", companyId!)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (cursor) q = q.lt("created_at", cursor);
    if (filters.agent) q = q.eq("agent_name", filters.agent);
    if (filters.eventType) q = q.eq("event_type", filters.eventType);
    if (filters.severity) q = q.eq("severity", filters.severity);
    if (filters.dateFrom) q = q.gte("created_at", filters.dateFrom);
    if (filters.dateTo) q = q.lte("created_at", filters.dateTo + "T23:59:59");
    if (filters.search) q = q.ilike("message", `%${filters.search}%`);

    return q;
  }

  // Fetch events
  useEffect(() => {
    if (!companyId || !isSupabaseConfigured()) {
      setEvents([]);
      setIsLoading(false);
      return;
    }

    const supabase = getSupabase();

    async function fetchEvents() {
      setIsLoading(true);
      const { data } = await buildQuery(supabase, PAGE_SIZE);
      if (data) {
        setEvents(data as Event[]);
        setHasMore(data.length === PAGE_SIZE);
      }
      setIsLoading(false);
    }

    fetchEvents();

    // Realtime for new events
    const channel = supabase
      .channel(`logs-${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "events",
          filter: `company_id=eq.${companyId}`,
        },
        (payload) => {
          const newEvent = payload.new as Event;
          // Check if it passes current filters
          if (filters.agent && newEvent.agent_name !== filters.agent) return;
          if (filters.eventType && newEvent.event_type !== filters.eventType) return;
          if (filters.severity && newEvent.severity !== filters.severity) return;

          setEvents((prev) => {
            const next = [newEvent, ...prev];
            return next.slice(0, MAX_EVENTS);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, filters.agent, filters.eventType, filters.severity, filters.dateFrom, filters.dateTo, filters.search]);

  // Load more (cursor pagination)
  const loadMore = useCallback(async () => {
    if (!companyId || !isSupabaseConfigured() || events.length === 0) return;
    const supabase = getSupabase();
    const cursor = events[events.length - 1].created_at;
    const { data } = await buildQuery(supabase, LOAD_MORE_SIZE, cursor);
    if (data) {
      setEvents((prev) => {
        const combined = [...prev, ...(data as Event[])];
        return combined.slice(0, MAX_EVENTS);
      });
      setHasMore(data.length === LOAD_MORE_SIZE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, events, filters]);

  const setFilters = useCallback((partial: Partial<LogFilters>) => {
    setFiltersState((prev) => ({ ...prev, ...partial }));
  }, []);

  // Export CSV
  const exportCSV = useCallback(
    (companyName: string) => {
      const header = "timestamp,severity,agent,event_type,message,metadata\n";
      const rows = events
        .map((e) => {
          const ts = e.created_at;
          const sev = e.severity;
          const agent = e.agent_name ?? "";
          const type = e.event_type;
          const msg = `"${(e.message ?? "").replace(/"/g, '""')}"`;
          const meta = `"${JSON.stringify(e.metadata ?? {}).replace(/"/g, '""')}"`;
          return `${ts},${sev},${agent},${type},${msg},${meta}`;
        })
        .join("\n");

      const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `vincera-logs-${companyName.toLowerCase().replace(/\s+/g, "-")}-${date}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [events]
  );

  return { events, isLoading, hasMore, loadMore, filters, setFilters, exportCSV };
}
