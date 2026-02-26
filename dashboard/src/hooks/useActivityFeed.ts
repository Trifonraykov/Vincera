"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeedItem {
  id: string;
  source: "event" | "message";
  type: string; // event_type or message_type
  agentName: string | null;
  content: string;
  severity: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const FEED_LIMIT = 20;

export function useActivityFeed(companyId: string | null): {
  items: FeedItem[];
  isLoading: boolean;
} {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  const mergeAndSort = useCallback(
    (events: FeedItem[], messages: FeedItem[]): FeedItem[] => {
      const merged = [...events, ...messages];
      merged.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      return merged.slice(0, FEED_LIMIT);
    },
    []
  );

  useEffect(() => {
    if (!companyId || !isSupabaseConfigured()) {
      setItems([]);
      setIsLoading(false);
      return;
    }

    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient();
    }
    const supabase = supabaseRef.current;

    async function fetchFeed() {
      // Fetch recent events
      const { data: eventRows } = await supabase
        .from("events")
        .select("id, event_type, agent_name, message, severity, created_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(15);

      // Fetch recent non-chat messages (alerts, discovery_narrations, ghost_reports)
      const { data: msgRows } = await supabase
        .from("messages")
        .select("id, message_type, sender, content, created_at")
        .eq("company_id", companyId)
        .neq("message_type", "chat")
        .order("created_at", { ascending: false })
        .limit(15);

      const eventItems: FeedItem[] = (eventRows ?? []).map((e) => ({
        id: e.id,
        source: "event" as const,
        type: e.event_type,
        agentName: e.agent_name,
        content: e.message,
        severity: e.severity,
        createdAt: e.created_at,
      }));

      const msgItems: FeedItem[] = (msgRows ?? []).map((m) => ({
        id: m.id,
        source: "message" as const,
        type: m.message_type,
        agentName: m.sender,
        content: m.content,
        severity: m.message_type === "alert" ? "warning" : "info",
        createdAt: m.created_at,
      }));

      setItems(mergeAndSort(eventItems, msgItems));
      setIsLoading(false);
    }

    fetchFeed();

    // Realtime: events + messages on one channel
    const channel = supabase
      .channel(`overview-feed-${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "events",
          filter: `company_id=eq.${companyId}`,
        },
        (payload) => {
          const e = payload.new as {
            id: string;
            event_type: string;
            agent_name: string | null;
            message: string;
            severity: string;
            created_at: string;
          };
          const item: FeedItem = {
            id: e.id,
            source: "event",
            type: e.event_type,
            agentName: e.agent_name,
            content: e.message,
            severity: e.severity,
            createdAt: e.created_at,
          };
          setItems((prev) => [item, ...prev].slice(0, FEED_LIMIT));
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `company_id=eq.${companyId}`,
        },
        (payload) => {
          const m = payload.new as {
            id: string;
            message_type: string;
            sender: string;
            content: string;
            created_at: string;
          };
          if (m.message_type === "chat") return; // skip chat messages
          const item: FeedItem = {
            id: m.id,
            source: "message",
            type: m.message_type,
            agentName: m.sender,
            content: m.content,
            severity: m.message_type === "alert" ? "warning" : "info",
            createdAt: m.created_at,
          };
          setItems((prev) => [item, ...prev].slice(0, FEED_LIMIT));
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
  }, [companyId, mergeAndSort]);

  return { items, isLoading };
}
