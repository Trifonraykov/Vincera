"use client";

import { motion } from "framer-motion";
import { ScrollText } from "lucide-react";
import { pageTransition } from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import LogViewer from "@/components/logs/LogViewer";

export default function LogsPage() {
  const { companyId, company } = useDashboard();

  return (
    <motion.div
      variants={pageTransition}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <ScrollText className="h-6 w-6 text-text-muted" />
          <h1 className="font-heading text-3xl font-semibold text-text-primary">
            Logs
          </h1>
          <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
        </div>
        <p className="mt-1 font-body text-sm text-text-secondary">
          System event log &mdash; real-time
        </p>
      </div>

      {companyId ? (
        <LogViewer companyId={companyId} companyName={company?.name ?? "company"} />
      ) : (
        <div className="flex h-40 items-center justify-center">
          <span className="font-mono text-sm text-text-muted">
            Select a company to view logs.
          </span>
        </div>
      )}
    </motion.div>
  );
}
