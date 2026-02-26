"use client";

import { useState, useCallback, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence } from "framer-motion";
import { DashboardProvider, useDashboard } from "@/contexts/DashboardContext";
import Sidebar from "@/components/ui/Sidebar";
import TopBar from "@/components/ui/TopBar";
import PauseOverlay from "@/components/ui/PauseOverlay";
import ParticleCanvas from "@/components/ui/ParticleCanvas";
import type { ParticleCanvasHandle } from "@/components/ui/ParticleCanvas";
import type { AgentStatus } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Inner shell — needs access to DashboardContext
// ---------------------------------------------------------------------------

function DashboardShell({ children }: { children: ReactNode }) {
  const { isPaused, togglePause, agentStatuses } = useDashboard();
  const pathname = usePathname();
  const particleRef = useRef<ParticleCanvasHandle>(null);

  const [overlayVisible, setOverlayVisible] = useState(false);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const [frozenAgents, setFrozenAgents] = useState<AgentStatus[]>([]);
  const [pausedAt, setPausedAt] = useState<string | null>(null);

  const handlePause = useCallback(
    async (rect: DOMRect) => {
      if (isPaused) {
        // Already paused → resume
        await togglePause();
        setOverlayVisible(false);
        particleRef.current?.resume();
      } else {
        // Pause
        setButtonRect(rect);
        setFrozenAgents([...agentStatuses]);
        setPausedAt(
          new Date().toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
        );
        setOverlayVisible(true);
        particleRef.current?.pause();
        await togglePause();
      }
    },
    [isPaused, togglePause, agentStatuses]
  );

  const handleResume = useCallback(async () => {
    await togglePause();
    setOverlayVisible(false);
    particleRef.current?.resume();
  }, [togglePause]);

  return (
    <div className="flex h-screen overflow-hidden bg-bg-primary">
      <ParticleCanvas ref={particleRef} />
      <Sidebar />

      {/* Main area — offset by collapsed sidebar width */}
      <div className="flex flex-1 flex-col" style={{ marginLeft: 56 }}>
        <TopBar onPause={handlePause} />

        {/* Scrollable content */}
        <main className="relative z-[10] flex-1 overflow-y-auto p-6">
          <AnimatePresence mode="wait">
            <div key={pathname}>{children}</div>
          </AnimatePresence>
        </main>
      </div>

      <PauseOverlay
        isVisible={overlayVisible}
        onResume={handleResume}
        buttonRect={buttonRect}
        frozenAgents={frozenAgents}
        pausedAt={pausedAt}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout — wraps children in providers
// ---------------------------------------------------------------------------

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardProvider>
      <DashboardShell>{children}</DashboardShell>
    </DashboardProvider>
  );
}
