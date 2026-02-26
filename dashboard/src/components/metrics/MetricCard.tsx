"use client";

import { motion } from "framer-motion";
import { cardEntrance } from "@/lib/animations";
import { useNumberCountUp } from "@/lib/animations";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MetricCardProps {
  label: string;
  value: number;
  suffix?: string;
  icon: LucideIcon;
  pulse?: boolean;
  onClick?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MetricCard({
  label,
  value,
  suffix,
  icon: Icon,
  pulse,
  onClick,
}: MetricCardProps) {
  const animatedValue = useNumberCountUp(value, 1.2);

  return (
    <motion.div
      variants={cardEntrance}
      whileHover={{ y: -2, borderColor: "#2A2A2A" }}
      onClick={onClick}
      className={cn(
        "relative rounded-lg border border-border-primary bg-bg-surface p-5 transition-colors",
        onClick && "cursor-pointer",
        pulse && value > 0 && "border-warning/40"
      )}
    >
      {/* Pulse ring when active */}
      {pulse && value > 0 && (
        <span className="absolute right-3 top-3 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-warning" />
        </span>
      )}

      <Icon className="mb-3 h-5 w-5 text-text-muted" />

      <p className="mb-1 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
        {label}
      </p>

      <p className="font-mono text-3xl font-medium text-text-primary">
        {animatedValue}
        {suffix && (
          <span className="ml-1 text-lg text-text-muted">{suffix}</span>
        )}
      </p>
    </motion.div>
  );
}
