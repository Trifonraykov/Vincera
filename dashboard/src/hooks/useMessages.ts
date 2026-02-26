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
  // Initial fetch
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
      const { data } = await supabase
        .from("messages")
        .select("*")
        .eq("company_id", companyId)
        .or(`sender.eq.${agentName},sender.eq.user,sender.eq.system`)
        .order("created_at", { ascending: true })
        .limit(PAGE_SIZE);

      const rows = (data ?? []) as Message[];
      rows.forEach((m) => knownIdsRef.current.add(m.id));
      setMessages(rows);
      setHasMore(rows.length === PAGE_SIZE);
      setIsLoading(false);
    }

    fetchInitial();

    // Realtime subscription
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
          // Only include messages relevant to this agent conversation
          if (
            newMsg.sender !== agentName &&
            newMsg.sender !== "user" &&
            newMsg.sender !== "system"
          ) {
            return;
          }

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

    const { data } = await supabase
      .from("messages")
      .select("*")
      .eq("company_id", companyId)
      .or(`sender.eq.${agentName},sender.eq.user,sender.eq.system`)
      .lt("created_at", oldest.created_at)
      .order("created_at", { ascending: true })
      .limit(PAGE_SIZE);

    const rows = (data ?? []) as Message[];
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

      const optimisticId = `optimistic-${Date.now()}`;
      const optimisticMsg: Message = {
        id: optimisticId,
        company_id: companyId,
        sender: "user",
        content: content.trim(),
        message_type: "chat",
        metadata: {},
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
          metadata: {},
        });
      }
    },
    [companyId]
  );

  return { messages, isLoading, hasMore, loadMore, sendMessage };
}
