"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Bot, ChevronDown } from "lucide-react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import { useMessages } from "@/hooks/useMessages";
import { useDashboard } from "@/contexts/DashboardContext";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";
import AgentTyping from "./AgentTyping";

interface ChatWindowProps {
  companyId: string;
  agentName: string;
}

export default function ChatWindow({ companyId, agentName }: ChatWindowProps) {
  const { isPaused } = useDashboard();
  const { messages, isLoading, hasMore, loadMore, sendMessage } = useMessages(
    companyId,
    agentName
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const prevLengthRef = useRef(0);
  // Track initial message count to know which messages are "new"
  const initialCountRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isLoading && initialCountRef.current === null) {
      initialCountRef.current = messages.length;
    }
  }, [isLoading, messages.length]);

  // Scroll tracking
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setIsAtBottom(atBottom);
    if (atBottom) setHasNewBelow(false);
  }

  // Auto-scroll on new messages
  useEffect(() => {
    if (messages.length > prevLengthRef.current) {
      if (isAtBottom) {
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: "smooth",
        });
      } else {
        setHasNewBelow(true);
      }
    }
    prevLengthRef.current = messages.length;
  }, [messages.length, isAtBottom]);

  // Scroll to bottom on mount
  useEffect(() => {
    if (!isLoading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [isLoading]);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
    setHasNewBelow(false);
  }, []);

  // Decision approve/reject
  const handleApprove = useCallback(
    async (decisionId: string, option: string) => {
      if (!isSupabaseConfigured()) return;
      const supabase = createBrowserClient();
      await supabase
        .from("decisions")
        .update({
          resolution: "approved",
          resolved_at: new Date().toISOString(),
          metadata: { chosen_option: option },
        })
        .eq("id", decisionId);
    },
    []
  );

  const handleReject = useCallback(async (decisionId: string) => {
    if (!isSupabaseConfigured()) return;
    const supabase = createBrowserClient();
    await supabase
      .from("decisions")
      .update({
        resolution: "rejected",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", decisionId);
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Messages area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {/* Load more */}
        {hasMore && (
          <div className="mb-4 text-center">
            <button
              onClick={loadMore}
              className="font-mono text-xs text-text-muted transition-colors hover:text-text-secondary"
            >
              Load earlier messages
            </button>
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex h-full items-center justify-center">
            <span className="font-mono text-sm text-text-muted">Loading...</span>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <Bot className="h-10 w-10 text-text-muted" />
            <p className="font-body text-sm text-text-muted">No conversation yet.</p>
            <p className="font-body text-xs text-text-muted">
              Send a message to start talking with{" "}
              <span className="capitalize">{agentName}</span>.
            </p>
          </div>
        )}

        {/* Messages */}
        {!isLoading && (
          <div className="space-y-4">
            {messages.map((msg, i) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                isNew={
                  initialCountRef.current !== null &&
                  i >= initialCountRef.current
                }
                onApproveDecision={handleApprove}
                onRejectDecision={handleReject}
              />
            ))}
            <AgentTyping
              companyId={companyId}
              agentName={agentName}
              messages={messages}
            />
          </div>
        )}
      </div>

      {/* New messages indicator */}
      {hasNewBelow && (
        <div className="flex justify-center pb-2">
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={scrollToBottom}
            className="flex items-center gap-1 rounded-full bg-bg-surface-raised px-3 py-1 font-mono text-xs text-accent shadow-lg"
          >
            <ChevronDown className="h-3 w-3" />
            New messages
          </motion.button>
        </div>
      )}

      {/* Input */}
      <ChatInput
        companyId={companyId}
        agentName={agentName}
        disabled={isPaused}
        onSend={sendMessage}
      />
    </div>
  );
}
