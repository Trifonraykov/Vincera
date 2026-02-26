"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { chatMessageIn } from "@/lib/animations";
import { useAgentStatus } from "@/hooks/useAgentStatus";
import type { Message } from "@/lib/supabase";

interface AgentTypingProps {
  companyId: string;
  agentName: string;
  messages: Message[];
}

export default function AgentTyping({
  companyId,
  agentName,
  messages,
}: AgentTypingProps) {
  const { status } = useAgentStatus(companyId, agentName);
  const [showTimeout, setShowTimeout] = useState(false);
  const [visibleSince, setVisibleSince] = useState<number | null>(null);

  // Determine if indicator should show
  const lastMessage = messages[messages.length - 1];
  const isAgentRunning = status?.status === "running";
  const lastWasUser = lastMessage?.sender === "user";
  const isVisible = isAgentRunning && lastWasUser;

  // Track when it became visible for timeout
  useEffect(() => {
    if (isVisible) {
      setVisibleSince(Date.now());
      setShowTimeout(false);
    } else {
      setVisibleSince(null);
      setShowTimeout(false);
    }
  }, [isVisible]);

  // 60s timeout
  useEffect(() => {
    if (!isVisible || !visibleSince) return;
    const timer = setTimeout(() => setShowTimeout(true), 60000);
    return () => clearTimeout(timer);
  }, [isVisible, visibleSince]);

  const dotDelay = [0, 0.15, 0.3];

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          variants={chatMessageIn}
          initial="hidden"
          animate="visible"
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          className="px-1"
        >
          <p className="mb-1.5 font-mono text-[11px] text-text-muted">
            {agentName} is thinking...
          </p>
          <div className="flex items-center gap-1.5">
            {dotDelay.map((delay, i) => (
              <motion.span
                key={i}
                className="inline-block h-1.5 w-1.5 rounded-full bg-text-secondary"
                animate={{
                  scale: [1, 1.4, 1],
                  opacity: [0.4, 1, 0.4],
                }}
                transition={{
                  duration: 1,
                  repeat: Infinity,
                  delay,
                  ease: "easeInOut",
                }}
              />
            ))}
          </div>
          {showTimeout && (
            <p className="mt-1 font-mono text-[11px] text-text-muted italic">
              This is taking longer than usual...
            </p>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
