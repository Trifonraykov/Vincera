"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  LayoutDashboard,
  Bot,
  Brain,
  Workflow,
  MessageSquareWarning,
  BookOpen,
  GraduationCap,
  Eye,
  ScrollText,
} from "lucide-react";
import { pulseGlow } from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import { cn } from "@/lib/utils";
import CompanySelector from "./CompanySelector";

// ---------------------------------------------------------------------------
// Nav config
// ---------------------------------------------------------------------------

const navItems = [
  { label: "Overview", icon: LayoutDashboard, href: "/dashboard", exact: true },
  { label: "Agents", icon: Bot, href: "/dashboard/agents", badge: "agents" as const },
  { label: "Brain View", icon: Brain, href: "/dashboard/brain" },
  { label: "Automations", icon: Workflow, href: "/dashboard/automations" },
  {
    label: "Decisions",
    icon: MessageSquareWarning,
    href: "/dashboard/decisions",
    badge: "decisions" as const,
  },
  { label: "Knowledge", icon: BookOpen, href: "/dashboard/knowledge" },
  { label: "Research", icon: GraduationCap, href: "/dashboard/research" },
  { label: "Ghost Mode", icon: Eye, href: "/dashboard/ghost" },
  { label: "Logs", icon: ScrollText, href: "/dashboard/logs" },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Sidebar() {
  const [isExpanded, setIsExpanded] = useState(false);
  const pathname = usePathname();
  const { agentSummary, pendingDecisions } = useDashboard();

  function isActive(href: string, exact?: boolean): boolean {
    if (exact) return pathname === href;
    return pathname === href || pathname.startsWith(href + "/");
  }

  function getBadgeCount(badge?: "agents" | "decisions"): number {
    if (badge === "agents") return agentSummary.running;
    if (badge === "decisions") return pendingDecisions;
    return 0;
  }

  return (
    <aside
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
      className="fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-border-primary bg-bg-primary"
      style={{
        width: isExpanded ? 240 : 56,
        transition: "width 200ms ease-out",
      }}
    >
      {/* Wordmark */}
      <div className="flex h-14 shrink-0 items-center overflow-hidden px-3">
        <motion.div variants={pulseGlow} animate="animate" className="rounded">
          {isExpanded ? (
            <span className="whitespace-nowrap font-heading text-lg font-semibold uppercase tracking-[0.3em] text-text-primary">
              Vincera
            </span>
          ) : (
            <span className="flex h-8 w-8 items-center justify-center font-heading text-lg font-semibold text-text-primary">
              V
            </span>
          )}
        </motion.div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2">
        {navItems.map((item) => {
          const active = isActive(item.href, "exact" in item ? item.exact : false);
          const Icon = item.icon;
          const badge = "badge" in item ? item.badge : undefined;
          const count = getBadgeCount(badge);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "group relative flex h-11 items-center gap-3 overflow-hidden transition-colors",
                isExpanded ? "px-4" : "justify-center px-0",
                active
                  ? "bg-accent-dim text-accent"
                  : "text-text-secondary hover:bg-bg-surface hover:text-text-primary"
              )}
            >
              {/* Active left bar */}
              {active && (
                <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r bg-accent" />
              )}

              {/* Icon */}
              <div className="relative shrink-0">
                <Icon className="h-5 w-5" />

                {/* Badge — collapsed: overlay on icon corner */}
                {!isExpanded && count > 0 && (
                  <span
                    className={cn(
                      "absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-black",
                      badge === "agents" ? "bg-accent" : "bg-warning"
                    )}
                  >
                    {count}
                  </span>
                )}
              </div>

              {/* Label + badge (expanded) */}
              <span
                className="flex-1 whitespace-nowrap text-sm font-body"
                style={{
                  opacity: isExpanded ? 1 : 0,
                  transition: "opacity 150ms ease-out",
                  transitionDelay: isExpanded ? "80ms" : "0ms",
                }}
              >
                {item.label}
              </span>

              {/* Badge — expanded: pill next to label */}
              {isExpanded && count > 0 && (
                <span
                  className={cn(
                    "flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-black",
                    badge === "agents" ? "bg-accent" : "bg-warning"
                  )}
                  style={{
                    opacity: isExpanded ? 1 : 0,
                    transition: "opacity 150ms ease-out",
                    transitionDelay: isExpanded ? "80ms" : "0ms",
                  }}
                >
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Divider */}
      <div className="mx-3 border-t border-border-primary" />

      {/* Company selector */}
      <div className="shrink-0 p-2">
        <CompanySelector isExpanded={isExpanded} />
      </div>
    </aside>
  );
}
