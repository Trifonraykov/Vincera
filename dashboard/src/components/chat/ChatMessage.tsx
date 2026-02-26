"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { chatMessageIn } from "@/lib/animations";
import { cn, timeAgo } from "@/lib/utils";
import type { Message, Json } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChatMessageProps {
  message: Message;
  isNew?: boolean;
  onApproveDecision?: (decisionId: string, option: string) => void;
  onRejectDecision?: (decisionId: string) => void;
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

function getMeta(metadata: Json, key: string): string | undefined {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const val = (metadata as Record<string, Json>)[key];
    if (typeof val === "string") return val;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sub-renderers
// ---------------------------------------------------------------------------

function UserChat({ message }: { message: Message }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[75%]">
        <div className="rounded-2xl rounded-br-sm bg-bg-surface-raised px-4 py-2.5">
          <p className="whitespace-pre-wrap font-body text-sm text-text-primary">
            {message.content}
          </p>
        </div>
        <p className="mt-1 text-right font-mono text-[11px] text-text-muted">
          {timeAgo(message.created_at)}
        </p>
      </div>
    </div>
  );
}

function AgentChat({ message }: { message: Message }) {
  return (
    <div className="max-w-[75%]">
      <p className="mb-1 font-mono text-[11px] text-text-muted capitalize">
        {message.sender}
      </p>
      <div className="rounded-2xl rounded-bl-sm bg-bg-surface px-4 py-2.5">
        <p className="whitespace-pre-wrap font-body text-sm text-text-secondary">
          {message.content}
        </p>
      </div>
      <p className="mt-1 font-mono text-[11px] text-text-muted">
        {timeAgo(message.created_at)}
      </p>
    </div>
  );
}

function DiscoveryNarration({ message }: { message: Message }) {
  return (
    <div className="relative max-w-[80%] pl-4">
      {/* Timeline border + dot */}
      <div className="absolute left-0 top-0 h-full w-0.5 bg-accent-dim" />
      <div className="absolute -left-[3px] top-2 h-1.5 w-1.5 rounded-full bg-accent" />
      <p className="whitespace-pre-wrap font-body text-sm italic text-text-secondary">
        {message.content}
      </p>
      <p className="mt-1 font-mono text-[11px] text-text-muted">
        {message.sender} &middot; {timeAgo(message.created_at)}
      </p>
    </div>
  );
}

function DecisionCard({
  message,
  onApprove,
  onReject,
}: {
  message: Message;
  onApprove?: (decisionId: string, option: string) => void;
  onReject?: (decisionId: string) => void;
}) {
  const [showContext, setShowContext] = useState(false);
  const decisionId = getMeta(message.metadata, "decision_id");
  const question = getMeta(message.metadata, "question") ?? message.content;
  const optionA = getMeta(message.metadata, "option_a") ?? "Option A";
  const optionB = getMeta(message.metadata, "option_b") ?? "Option B";
  const context = getMeta(message.metadata, "context");
  const riskLevel = getMeta(message.metadata, "risk_level") ?? "medium";
  const resolution = getMeta(message.metadata, "resolution");
  const expiresAt = getMeta(message.metadata, "expires_at");
  const isExpired =
    !resolution && expiresAt && new Date(expiresAt) < new Date();

  const riskColor =
    riskLevel === "high"
      ? "text-error border-error/30"
      : riskLevel === "medium"
        ? "text-warning"
        : "text-text-muted";

  return (
    <div
      className={cn(
        "max-w-[85%] rounded-lg border bg-bg-surface p-4",
        riskLevel === "high" ? "border-error/30" : "border-border-primary"
      )}
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <span className="font-body text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Decision Required
          </span>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 font-mono text-[10px] uppercase",
            riskColor
          )}
        >
          {riskLevel}
        </span>
      </div>

      {/* Question */}
      <p className="mb-3 font-heading text-base text-text-primary">{question}</p>

      {/* Context (collapsible) */}
      {context && (
        <div className="mb-3">
          <button
            onClick={() => setShowContext(!showContext)}
            className="flex items-center gap-1 font-body text-xs text-text-muted hover:text-text-secondary"
          >
            {showContext ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            {showContext ? "Hide context" : "Show context"}
          </button>
          {showContext && (
            <p className="mt-2 rounded bg-bg-primary p-2 font-mono text-xs text-text-muted">
              {context}
            </p>
          )}
        </div>
      )}

      {/* Options */}
      <div className="mb-3 space-y-1.5">
        <p className="font-body text-sm text-text-secondary">
          <span className="font-mono text-xs text-text-muted">A:</span> {optionA}
        </p>
        <p className="font-body text-sm text-text-secondary">
          <span className="font-mono text-xs text-text-muted">B:</span> {optionB}
        </p>
      </div>

      {/* Actions / Status */}
      {resolution ? (
        <p
          className={cn(
            "font-body text-sm font-medium",
            resolution === "approved" ? "text-accent" : "text-error"
          )}
        >
          {resolution === "approved" ? "✓ Approved" : "✗ Rejected"}
        </p>
      ) : isExpired ? (
        <p className="font-body text-sm text-text-muted italic">Expired</p>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => decisionId && onApprove?.(decisionId, "a")}
            className="rounded-md border border-accent px-3 py-1.5 font-body text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-black"
          >
            ✓ Approve A
          </button>
          <button
            onClick={() => decisionId && onReject?.(decisionId)}
            className="rounded-md border border-error px-3 py-1.5 font-body text-xs font-medium text-error transition-colors hover:bg-error hover:text-black"
          >
            ✗ Reject
          </button>
        </div>
      )}

      <p className="mt-2 font-mono text-[11px] text-text-muted">
        {timeAgo(message.created_at)}
      </p>
    </div>
  );
}

function GhostReport({ message }: { message: Message }) {
  const reportDate = getMeta(message.metadata, "report_date");
  return (
    <div className="max-w-[80%] rounded-lg border border-border-primary bg-bg-surface p-4">
      <div className="relative pl-4">
        <div className="absolute left-0 top-0 h-full w-0.5 bg-accent-dim" />
        <p className="mb-2 font-heading text-sm text-text-primary">
          {"👻"} Ghost Report{reportDate ? ` — ${reportDate}` : ""}
        </p>
        <p className="whitespace-pre-wrap font-body text-sm text-text-muted">
          {message.content}
        </p>
      </div>
      <p className="mt-2 font-mono text-[11px] text-text-muted">
        {timeAgo(message.created_at)}
      </p>
    </div>
  );
}

function AlertMessage({ message }: { message: Message }) {
  const severity = getMeta(message.metadata, "severity") ?? "warning";
  const isError = severity === "error" || severity === "critical";
  const Icon = isError ? AlertCircle : AlertTriangle;

  return (
    <div
      className={cn(
        "max-w-[80%] rounded-r-md border-l-[3px] px-4 py-2.5",
        isError
          ? "border-error bg-error/5"
          : "border-warning bg-warning/5"
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0",
            isError ? "text-error" : "text-warning"
          )}
        />
        <div>
          <p className="whitespace-pre-wrap font-body text-sm text-text-primary">
            {message.content}
          </p>
          <p className="mt-1 font-mono text-[11px] text-text-muted">
            {message.sender} &middot; {timeAgo(message.created_at)}
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ChatMessage({
  message,
  isNew,
  onApproveDecision,
  onRejectDecision,
}: ChatMessageProps) {
  const Wrapper = isNew ? motion.div : "div";
  const wrapperProps = isNew
    ? { variants: chatMessageIn, initial: "hidden", animate: "visible" }
    : {};

  function renderContent() {
    switch (message.message_type) {
      case "discovery_narration":
        return <DiscoveryNarration message={message} />;
      case "decision":
        return (
          <DecisionCard
            message={message}
            onApprove={onApproveDecision}
            onReject={onRejectDecision}
          />
        );
      case "ghost_report":
        return <GhostReport message={message} />;
      case "alert":
        return <AlertMessage message={message} />;
      case "chat":
      default:
        return message.sender === "user" ? (
          <UserChat message={message} />
        ) : (
          <AgentChat message={message} />
        );
    }
  }

  return (
    <Wrapper {...wrapperProps} className="px-1">
      {renderContent()}
    </Wrapper>
  );
}
