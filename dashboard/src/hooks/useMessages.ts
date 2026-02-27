"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { Message } from "@/lib/supabase";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

const PAGE_SIZE = 50;

export interface UseMessagesReturn {
  messages: Message[];
  isLoading: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helper: check if a message belongs to an agent conversation
// ---------------------------------------------------------------------------

function isRelevant(msg: Message, agentName: string): boolean {
  if (msg.sender === agentName || msg.sender === "system") return true;
  if (msg.sender === "user") {
    const meta = (msg.metadata ?? {}) as Record<string, unknown>;
    return meta.target_agent === agentName;
  }
  return false;
}

export function useMessages(
  companyId: string | null,
  agentName: string
): UseMessagesReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const knownIdsRef = useRef<Set<string>>(new Set());
  const optimisticIdsRef = useRef<Set<string>>(new Set());

  function getSupabase(): SupabaseClient {
    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient();
    }
    return supabaseRef.current;
  }

  // ---------------------------------------------------------------------------
  // Initial fetch — two queries to avoid PostgREST JSONB filter issues
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!companyId || !isSupabaseConfigured()) {
      setMessages([]);
      setIsLoading(false);
      return;
    }

    const supabase = getSupabase();
    setIsLoading(true);
    knownIdsRef.current.clear();
    optimisticIdsRef.current.clear();

    async function fetchInitial() {
      // Query 1: Agent responses + system messages
      const { data: agentData } = await supabase
        .from("messages")
        .select("*")
        .eq("company_id", companyId)
        .or(`sender.eq.${agentName},sender.eq.system`)
        .order("created_at", { ascending: true })
        .limit(PAGE_SIZE);

      // Query 2: User messages targeted at this agent (uses @> JSONB contains)
      const { data: userData } = await supabase
        .from("messages")
        .select("*")
        .eq("company_id", companyId)
        .eq("sender", "user")
        .contains("metadata", { target_agent: agentName })
        .order("created_at", { ascending: true })
        .limit(PAGE_SIZE);

      // Merge, deduplicate, sort chronologically
      const seen = new Set<string>();
      const merged: Message[] = [];
      for (const m of [...(agentData ?? []), ...(userData ?? [])] as Message[]) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          merged.push(m);
        }
      }
      merged.sort((a, b) => a.created_at.localeCompare(b.created_at));

      const rows = merged.slice(-PAGE_SIZE);
      rows.forEach((m) => knownIdsRef.current.add(m.id));
      setMessages(rows);
      setHasMore(merged.length > PAGE_SIZE);
      setIsLoading(false);
    }

    fetchInitial();

    // Realtime subscription — client-side filtering (always reliable)
    const channel = supabase
      .channel(`messages-${companyId}-${agentName}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `company_id=eq.${companyId}`,
        },
        (payload) => {
          const newMsg = payload.new as Message;
          if (!isRelevant(newMsg, agentName)) return;

          if (knownIdsRef.current.has(newMsg.id)) return;
          knownIdsRef.current.add(newMsg.id);

          setMessages((prev) => {
            // Replace optimistic message if one exists
            const optimisticIdx = prev.findIndex(
              (m) =>
                optimisticIdsRef.current.has(m.id) &&
                m.content === newMsg.content &&
                m.sender === newMsg.sender
            );
            if (optimisticIdx !== -1) {
              optimisticIdsRef.current.delete(prev[optimisticIdx].id);
              const updated = [...prev];
              updated[optimisticIdx] = newMsg;
              return updated;
            }
            return [...prev, newMsg];
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
  }, [companyId, agentName]);

  // ---------------------------------------------------------------------------
  // Load more (older messages)
  // ---------------------------------------------------------------------------

  const loadMore = useCallback(async () => {
    if (!companyId || !isSupabaseConfigured() || messages.length === 0) return;
    const supabase = getSupabase();
    const oldest = messages[0];

    // Same two-query approach for older messages
    const { data: agentData } = await supabase
      .from("messages")
      .select("*")
      .eq("company_id", companyId)
      .or(`sender.eq.${agentName},sender.eq.system`)
      .lt("created_at", oldest.created_at)
      .order("created_at", { ascending: true })
      .limit(PAGE_SIZE);

    const { data: userData } = await supabase
      .from("messages")
      .select("*")
      .eq("company_id", companyId)
      .eq("sender", "user")
      .contains("metadata", { target_agent: agentName })
      .lt("created_at", oldest.created_at)
      .order("created_at", { ascending: true })
      .limit(PAGE_SIZE);

    const seen = new Set<string>();
    const merged: Message[] = [];
    for (const m of [...(agentData ?? []), ...(userData ?? [])] as Message[]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }
    merged.sort((a, b) => a.created_at.localeCompare(b.created_at));

    const rows = merged.slice(-PAGE_SIZE);
    rows.forEach((m) => knownIdsRef.current.add(m.id));
    setMessages((prev) => [...rows, ...prev]);
    setHasMore(rows.length === PAGE_SIZE);
  }, [companyId, agentName, messages]);

  // ---------------------------------------------------------------------------
  // Send message (optimistic)
  // ---------------------------------------------------------------------------

  const sendMessage = useCallback(
    async (content: string) => {
      if (!companyId || !content.trim()) return;

      const meta = { target_agent: agentName };
      const optimisticId = `optimistic-${Date.now()}`;
      const optimisticMsg: Message = {
        id: optimisticId,
        company_id: companyId,
        sender: "user",
        content: content.trim(),
        message_type: "chat",
        metadata: meta,
        read: false,
        created_at: new Date().toISOString(),
      };

      optimisticIdsRef.current.add(optimisticId);
      knownIdsRef.current.add(optimisticId);
      setMessages((prev) => [...prev, optimisticMsg]);

      if (isSupabaseConfigured()) {
        const supabase = getSupabase();
        await supabase.from("messages").insert({
          company_id: companyId,
          sender: "user",
          content: content.trim(),
          message_type: "chat",
          metadata: meta,
        });
      }
    },
    [companyId, agentName]
  );

  return { messages, isLoading, hasMore, loadMore, sendMessage };
}
