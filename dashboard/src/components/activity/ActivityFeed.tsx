"use client";

import { motion } from "framer-motion";
import {
  AlertTriangle,
  AlertCircle,
  Search,
  Ghost,
  Zap,
  Info,
} from "lucide-react";
import { cardEntrance, chatMessageIn } from "@/lib/animations";
import { cn, timeAgo, truncate } from "@/lib/utils";
import type { FeedItem } from "@/hooks/useActivityFeed";

// ---------------------------------------------------------------------------
// Icon mapping
// ---------------------------------------------------------------------------

function feedIcon(item: FeedItem) {
  // By event_type or message_type
  const t = item.type;
  if (t === "alert" || t === "system_paused" || t === "system_resumed")
    return AlertTriangle;
  if (t === "error" || item.severity === "error" || item.severity === "critical")
    return AlertCircle;
  if (t === "discovery_narration" || t === "discovery") return Search;
  if (t === "ghost_report") return Ghost;
  if (t === "automation_deployed" || t === "automation_run") return Zap;
  return Info;
}

function severityColor(severity: string): string {
  switch (severity) {
    case "critical":
    case "error":
      return "text-error";
    case "warning":
      return "text-warning";
    default:
      return "text-text-muted";
  }
}

// ---------------------------------------------------------------------------
// Feed item row
// ---------------------------------------------------------------------------

function FeedRow({ item, isNew }: { item: FeedItem; isNew?: boolean }) {
  const Icon = feedIcon(item);
  const Wrapper = isNew ? motion.div : "div";
  const wrapperProps = isNew
    ? { variants: chatMessageIn, initial: "hidden", animate: "visible" }
    : {};

  return (
    <Wrapper
      {...wrapperProps}
      className="flex items-start gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-bg-surface-raised/50"
    >
      <Icon
        className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", severityColor(item.severity))}
      />
      <div className="min-w-0 flex-1">
        <p className="font-body text-xs text-text-secondary">
          {truncate(item.content, 100)}
        </p>
        <p className="mt-0.5 font-mono text-[10px] text-text-muted">
          {item.agentName && (
            <span className="capitalize">{item.agentName} · </span>
          )}
          {timeAgo(item.createdAt)}
        </p>
      </div>
    </Wrapper>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ActivityFeedProps {
  items: FeedItem[];
  isLoading: boolean;
}

export default function ActivityFeed({ items, isLoading }: ActivityFeedProps) {
  return (
    <motion.div
      variants={cardEntrance}
      className="flex h-full flex-col rounded-lg border border-border-primary bg-bg-surface p-4"
    >
      <h3 className="mb-3 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
        Activity
      </h3>

      <div className="flex-1 space-y-0.5 overflow-y-auto">
        {isLoading && (
          <p className="py-4 text-center font-mono text-xs text-text-muted">
            Loading...
          </p>
        )}

        {!isLoading && items.length === 0 && (
          <p className="py-4 text-center font-body text-xs text-text-muted italic">
            No recent activity
          </p>
        )}

        {!isLoading &&
          items.map((item) => <FeedRow key={item.id} item={item} />)}
      </div>
    </motion.div>
  );
}
