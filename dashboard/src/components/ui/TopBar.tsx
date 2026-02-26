"use client";

import { useRef } from "react";
import { motion } from "framer-motion";
import { Pause, Play } from "lucide-react";
import { useDashboard } from "@/contexts/DashboardContext";
import { cn } from "@/lib/utils";

interface TopBarProps {
  onPause: (buttonRect: DOMRect) => void;
}

export default function TopBar({ onPause }: TopBarProps) {
  const {
    company,
    isPaused,
    agentSummary,
    isConnected,
  } = useDashboard();
  const buttonRef = useRef<HTMLButtonElement>(null);

  function handlePauseClick() {
    if (buttonRef.current) {
      onPause(buttonRef.current.getBoundingClientRect());
    }
  }

  return (
    <header className="flex h-14 shrink-0 items-center border-b border-border-primary bg-bg-primary px-6">
      {/* Company name */}
      <div className="min-w-0 flex-shrink-0">
        {company ? (
          <h1 className="truncate font-heading text-lg text-text-primary">
            {company.name}
          </h1>
        ) : (
          <span className="text-sm text-text-muted font-body">
            No company selected
          </span>
        )}
      </div>

      {/* Agent summary */}
      <div className="ml-8 hidden items-center gap-1 text-xs font-body sm:flex">
        <span className="text-text-secondary">{agentSummary.total} agents</span>
        <span className="text-text-muted">&middot;</span>
        <span className="text-accent">{agentSummary.running} running</span>
        <span className="text-text-muted">&middot;</span>
        <span className="text-text-muted">{agentSummary.idle} idle</span>
        {agentSummary.failed > 0 && (
          <>
            <span className="text-text-muted">&middot;</span>
            <span className="text-error">{agentSummary.failed} failed</span>
          </>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Connection status */}
      <div className="mr-6 flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          {isConnected && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-40" />
          )}
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              isConnected ? "bg-accent" : "bg-error"
            )}
          />
        </span>
        <span className="text-xs text-text-muted font-body">
          {isConnected ? "Connected" : "Disconnected"}
        </span>
      </div>

      {/* PAUSE / RESUME button */}
      <motion.button
        ref={buttonRef}
        onClick={handlePauseClick}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.97 }}
        className={cn(
          "flex items-center gap-2 rounded-md border px-4 py-1.5 text-xs font-body font-semibold uppercase tracking-widest transition-all",
          isPaused
            ? "animate-breathe border-accent text-accent shadow-[0_0_12px_rgba(0,255,136,0.2)]"
            : "border-accent text-accent hover:bg-accent hover:text-black hover:shadow-[0_0_20px_rgba(0,255,136,0.3)]"
        )}
      >
        {isPaused ? (
          <>
            <Play className="h-3.5 w-3.5" />
            Resume
          </>
        ) : (
          <>
            <Pause className="h-3.5 w-3.5" />
            Pause All
          </>
        )}
      </motion.button>
    </header>
  );
}
