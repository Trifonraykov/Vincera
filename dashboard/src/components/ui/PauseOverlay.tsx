"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Pause, Play } from "lucide-react";
import { dissolveIn, slideInRight, breathe, staggerChildren } from "@/lib/animations";
import type { AgentStatus } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PauseOverlayProps {
  isVisible: boolean;
  onResume: () => void;
  buttonRect: DOMRect | null;
  frozenAgents: AgentStatus[];
  pausedAt: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PauseOverlay({
  isVisible,
  onResume,
  buttonRect,
  frozenAgents,
  pausedAt,
}: PauseOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Escape key → resume
  useEffect(() => {
    if (!isVisible) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onResume();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isVisible, onResume]);

  // Focus trap
  useEffect(() => {
    if (isVisible && overlayRef.current) {
      overlayRef.current.focus();
    }
  }, [isVisible]);

  const runningAgents = frozenAgents.filter((a) => a.status === "running");

  // Ripple origin — center of PAUSE button, or screen center as fallback
  const rippleX = buttonRect
    ? buttonRect.left + buttonRect.width / 2
    : typeof window !== "undefined"
      ? window.innerWidth / 2
      : 500;
  const rippleY = buttonRect
    ? buttonRect.top + buttonRect.height / 2
    : typeof window !== "undefined"
      ? window.innerHeight / 2
      : 300;

  return (
    <AnimatePresence>
      {isVisible && (
        <>
          {/* Step 1: Ripple from button */}
          <motion.div
            key="ripple"
            initial={{ scale: 0, opacity: 0.5 }}
            animate={{ scale: 4, opacity: 0 }}
            transition={{ duration: 0.6, ease: [0.33, 1, 0.68, 1] }}
            className="pointer-events-none fixed z-[100] rounded-full border-2 border-accent"
            style={{
              left: rippleX - 30,
              top: rippleY - 30,
              width: 60,
              height: 60,
            }}
          />

          {/* Step 2: Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.3, delay: 0.15 } }}
            transition={{ duration: 0.4, delay: 0.15 }}
            className="fixed inset-0 z-[101] bg-black/92 backdrop-blur-md"
          />

          {/* Step 3: Content */}
          <motion.div
            key="content"
            ref={overlayRef}
            tabIndex={-1}
            className="fixed inset-0 z-[102] flex items-center justify-center outline-none"
            initial="hidden"
            animate="visible"
            exit="hidden"
            variants={{
              hidden: { opacity: 0 },
              visible: {
                opacity: 1,
                transition: {
                  delay: 0.35,
                  staggerChildren: 0.12,
                },
              },
            }}
          >
            <div className="flex max-w-lg flex-col items-center gap-6 px-8 text-center">
              {/* Pause icon */}
              <motion.div variants={dissolveIn}>
                <Pause className="h-16 w-16 text-accent" strokeWidth={1.5} />
              </motion.div>

              {/* PAUSED heading */}
              <motion.div variants={dissolveIn} className="space-y-3">
                <h2 className="font-heading text-7xl font-semibold uppercase tracking-[0.4em] text-text-primary">
                  Paused
                </h2>
                {/* Breathing accent border */}
                <motion.div
                  variants={breathe}
                  animate="animate"
                  className="mx-auto h-0.5 w-32 rounded-full bg-accent"
                />
              </motion.div>

              {/* Timestamp */}
              <motion.p
                variants={dissolveIn}
                className="font-mono text-sm text-text-muted"
              >
                System halted at {pausedAt ?? "--:--:--"}
              </motion.p>

              {/* Divider */}
              <motion.div
                variants={dissolveIn}
                className="h-px w-full bg-border-primary"
              />

              {/* In-progress agents */}
              <motion.div
                variants={staggerChildren(0.08)}
                initial="hidden"
                animate="visible"
                className="w-full space-y-1 text-left"
              >
                <motion.p
                  variants={slideInRight}
                  className="mb-2 text-xs font-body uppercase tracking-widest text-text-muted"
                >
                  In Progress When Paused:
                </motion.p>

                {runningAgents.length > 0 ? (
                  runningAgents.map((agent) => (
                    <motion.p
                      key={agent.id}
                      variants={slideInRight}
                      className="flex items-start gap-2 font-mono text-sm text-text-secondary"
                    >
                      <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                      <span>
                        <span className="capitalize text-text-primary">
                          {agent.agent_name}
                        </span>
                        {agent.current_task && (
                          <span className="text-text-muted">
                            {" "}
                            &mdash; {agent.current_task}
                          </span>
                        )}
                      </span>
                    </motion.p>
                  ))
                ) : (
                  <motion.p
                    variants={slideInRight}
                    className="font-mono text-sm text-text-muted italic"
                  >
                    All agents were idle
                  </motion.p>
                )}
              </motion.div>

              {/* Divider */}
              <motion.div
                variants={dissolveIn}
                className="h-px w-full bg-border-primary"
              />

              {/* Resume button */}
              <motion.button
                variants={dissolveIn}
                onClick={onResume}
                whileHover={{
                  scale: 1.02,
                  backgroundColor: "rgba(0, 255, 136, 1)",
                  color: "#000",
                }}
                whileTap={{ scale: 0.97 }}
                className="flex items-center gap-2 rounded-md border border-accent px-8 py-3 font-body text-sm font-semibold uppercase tracking-widest text-accent shadow-[0_0_12px_rgba(0,255,136,0.15)] animate-breathe transition-colors"
              >
                <Play className="h-4 w-4" />
                Resume
              </motion.button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
