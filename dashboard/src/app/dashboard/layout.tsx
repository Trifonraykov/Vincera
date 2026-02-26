"use client";

import { useState, useCallback, type ReactNode } from "react";
import { DashboardProvider, useDashboard } from "@/contexts/DashboardContext";
import Sidebar from "@/components/ui/Sidebar";
import TopBar from "@/components/ui/TopBar";
import PauseOverlay from "@/components/ui/PauseOverlay";
import type { AgentStatus } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Inner shell — needs access to DashboardContext
// ---------------------------------------------------------------------------

function DashboardShell({ children }: { children: ReactNode }) {
  const { isPaused, togglePause, agentStatuses } = useDashboard();

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
        await togglePause();
      }
    },
    [isPaused, togglePause, agentStatuses]
  );

  const handleResume = useCallback(async () => {
    await togglePause();
    setOverlayVisible(false);
  }, [togglePause]);

  return (
    <div className="flex h-screen overflow-hidden bg-bg-primary">
      <Sidebar />

      {/* Main area — offset by collapsed sidebar width */}
      <div className="flex flex-1 flex-col" style={{ marginLeft: 56 }}>
        <TopBar onPause={handlePause} />

        {/* Scrollable content */}
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
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
