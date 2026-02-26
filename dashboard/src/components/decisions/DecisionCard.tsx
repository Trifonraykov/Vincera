"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Bot, Check, X, ChevronDown, ChevronUp } from "lucide-react";
import { cardEntrance } from "@/lib/animations";
import { cn, timeAgo } from "@/lib/utils";
import type { Decision } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DecisionCardProps {
  decision: Decision;
  onApprove: (id: string, option: string, note?: string) => void;
  onReject: (id: string, reason?: string) => void;
}

// ---------------------------------------------------------------------------
// Countdown hook
// ---------------------------------------------------------------------------

function useCountdown(expiresAt: string | null, isResolved: boolean) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!expiresAt || isResolved) {
      setRemaining(null);
      return;
    }

    function calc() {
      const diff = new Date(expiresAt!).getTime() - Date.now();
      setRemaining(Math.max(diff, 0));
    }

    calc();

    // Adaptive interval: every second when < 5min, else every 60s
    const id = setInterval(() => {
      calc();
    }, remaining !== null && remaining < 300_000 ? 1000 : 60_000);

    return () => clearInterval(id);
  }, [expiresAt, isResolved, remaining]);

  if (remaining === null) return null;
  if (remaining <= 0) return "expired";

  const totalSec = Math.floor(remaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);

  let text: string;
  if (h > 0) text = `${h}h ${m}m`;
  else if (m > 0) text = `${m}m`;
  else text = `< 1m`;

  const color =
    remaining < 300_000
      ? "text-error animate-pulse"
      : remaining < 1_800_000
        ? "text-warning"
        : "text-text-muted";

  return { text, color, isExpired: false };
}

// ---------------------------------------------------------------------------
// Risk rendering
// ---------------------------------------------------------------------------

function riskStyle(risk: string) {
  switch (risk) {
    case "high":
      return {
        dot: "bg-error",
        text: "text-error font-medium",
        border: "border-l-[3px] border-l-error",
        tint: "bg-error/[0.03]",
      };
    case "medium":
      return {
        dot: "bg-warning",
        text: "text-warning",
        border: "border-l-[3px] border-l-warning",
        tint: "",
      };
    default:
      return { dot: "bg-text-muted", text: "text-text-muted", border: "", tint: "" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DecisionCard({
  decision,
  onApprove,
  onReject,
}: DecisionCardProps) {
  const [showContext, setShowContext] = useState(false);
  const [approveFlow, setApproveFlow] = useState(false);
  const [rejectFlow, setRejectFlow] = useState(false);
  const [selectedOption, setSelectedOption] = useState<"a" | "b">("a");
  const [approveNote, setApproveNote] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  const isResolved = decision.resolution !== null;
  const countdown = useCountdown(decision.expires_at, isResolved);
  const isExpired =
    !isResolved &&
    (countdown === "expired" ||
      (decision.expires_at && new Date(decision.expires_at) < new Date()));

  const risk = riskStyle(decision.risk_level);
  const contextLong =
    decision.context !== null && decision.context.length > 150;
  const hasOptionB = decision.option_b && decision.option_b.trim().length > 0;

  function handleApprove() {
    if (hasOptionB) {
      setApproveFlow(true);
    } else {
      onApprove(decision.id, "a");
    }
  }

  function confirmApprove() {
    onApprove(decision.id, selectedOption, approveNote || undefined);
    setApproveFlow(false);
  }

  function confirmReject() {
    onReject(decision.id, rejectReason || undefined);
    setRejectFlow(false);
  }

  return (
    <motion.div
      variants={cardEntrance}
      layout
      exit={{ opacity: 0, x: -40, transition: { duration: 0.3 } }}
      className={cn(
        "rounded-lg border border-border-primary bg-bg-surface p-6",
        risk.border,
        risk.tint,
        isExpired && !isResolved && "opacity-60"
      )}
    >
      {/* Header row */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Agent badge */}
          <Link
            href={`/dashboard/agents/${decision.agent_name}`}
            className="flex items-center gap-1.5 transition-colors hover:text-accent"
          >
            <Bot className="h-3.5 w-3.5 text-accent" />
            <span className="font-mono text-xs text-accent">
              {decision.agent_name}
            </span>
          </Link>

          {/* Risk level */}
          <div className="flex items-center gap-1.5">
            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", risk.dot)} />
            <span className={cn("font-body text-xs", risk.text)}>
              {decision.risk_level} risk
            </span>
          </div>
        </div>

        {/* Countdown / Status */}
        {isResolved ? (
          <span
            className={cn(
              "font-body text-xs font-medium",
              decision.resolution === "approved" ? "text-accent" : "text-error"
            )}
          >
            {decision.resolution === "approved" ? "\u2713 Approved" : "\u2717 Rejected"}
          </span>
        ) : isExpired ? (
          <span className="font-mono text-xs text-error">Expired</span>
        ) : countdown && typeof countdown === "object" ? (
          <span className={cn("font-mono text-xs", countdown.color)}>
            Expires: {countdown.text}
          </span>
        ) : null}
      </div>

      {/* Question */}
      <h3 className="mb-3 font-heading text-xl text-text-primary">
        {decision.question}
      </h3>

      {/* Context */}
      {decision.context && (
        <div className="mb-3">
          <p className="font-body text-sm text-text-secondary">
            {contextLong && !showContext
              ? decision.context.slice(0, 150) + "\u2026"
              : decision.context}
          </p>
          {contextLong && (
            <button
              onClick={() => setShowContext(!showContext)}
              className="mt-1 flex items-center gap-1 font-body text-xs text-text-muted transition-colors hover:text-text-secondary"
            >
              {showContext ? (
                <>
                  <ChevronUp className="h-3 w-3" /> show less
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" /> show more
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* Options */}
      <div className="mb-4 space-y-1.5 border-l-2 border-border-primary pl-3">
        <p className="font-body text-sm text-text-primary">
          <span className="mr-2 font-mono text-xs text-text-muted">A:</span>
          {decision.option_a}
        </p>
        {hasOptionB && (
          <p className="font-body text-sm text-text-primary">
            <span className="mr-2 font-mono text-xs text-text-muted">B:</span>
            {decision.option_b}
          </p>
        )}
      </div>

      {/* Action buttons — only for pending */}
      {!isResolved && !isExpired && !approveFlow && !rejectFlow && (
        <div className="flex items-center gap-3">
          <button
            onClick={handleApprove}
            className="flex h-11 items-center gap-2 rounded-md bg-accent px-5 font-body text-sm font-medium text-black transition-opacity hover:opacity-90"
          >
            <Check className="h-4 w-4" />
            Approve
          </button>
          <button
            onClick={() => setRejectFlow(true)}
            className="flex h-11 items-center gap-2 rounded-md border border-text-secondary px-5 font-body text-sm font-medium text-text-primary transition-colors hover:border-error hover:text-error"
          >
            <X className="h-4 w-4" />
            Reject
          </button>
        </div>
      )}

      {/* Approve flow: option selection */}
      {approveFlow && !isResolved && (
        <div className="mt-2 rounded-md bg-bg-primary p-4">
          <p className="mb-3 font-body text-sm font-medium text-text-primary">
            Approve which option?
          </p>
          <div className="mb-3 space-y-2">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name={`option-${decision.id}`}
                checked={selectedOption === "a"}
                onChange={() => setSelectedOption("a")}
                className="mt-1 accent-[#00FF88]"
              />
              <span className="font-body text-sm text-text-secondary">
                <span className="font-mono text-xs text-text-muted">A:</span>{" "}
                {decision.option_a}
              </span>
            </label>
            {hasOptionB && (
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name={`option-${decision.id}`}
                  checked={selectedOption === "b"}
                  onChange={() => setSelectedOption("b")}
                  className="mt-1 accent-[#00FF88]"
                />
                <span className="font-body text-sm text-text-secondary">
                  <span className="font-mono text-xs text-text-muted">B:</span>{" "}
                  {decision.option_b}
                </span>
              </label>
            )}
          </div>
          <textarea
            value={approveNote}
            onChange={(e) => setApproveNote(e.target.value)}
            placeholder="Note (optional)"
            rows={2}
            className="mb-3 w-full resize-none rounded-md border border-border-primary bg-bg-surface px-3 py-2 font-body text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={confirmApprove}
              className="rounded-md bg-accent px-4 py-2 font-body text-xs font-medium text-black transition-opacity hover:opacity-90"
            >
              Confirm Approval
            </button>
            <button
              onClick={() => setApproveFlow(false)}
              className="rounded-md px-4 py-2 font-body text-xs text-text-secondary transition-colors hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Reject flow: reason */}
      {rejectFlow && !isResolved && (
        <div className="mt-2 rounded-md bg-bg-primary p-4">
          <p className="mb-2 font-body text-sm font-medium text-text-primary">
            Why are you rejecting this?{" "}
            <span className="font-normal text-text-muted">(optional)</span>
          </p>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Your feedback helps the agent learn and improve."
            rows={3}
            className="mb-3 w-full resize-none rounded-md border border-border-primary bg-bg-surface px-3 py-2 font-body text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={confirmReject}
              className="rounded-md border border-error bg-error/10 px-4 py-2 font-body text-xs font-medium text-error transition-colors hover:bg-error/20"
            >
              Confirm Rejection
            </button>
            <button
              onClick={() => setRejectFlow(false)}
              className="rounded-md px-4 py-2 font-body text-xs text-text-secondary transition-colors hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
          <p className="mt-2 font-body text-[10px] text-text-muted italic">
            This feedback helps the agent learn and improve.
          </p>
        </div>
      )}

      {/* Resolved info */}
      {isResolved && (
        <div className="mt-2">
          <p
            className={cn(
              "font-body text-sm font-medium",
              decision.resolution === "approved" ? "text-accent" : "text-error"
            )}
          >
            {decision.resolution === "approved"
              ? `\u2713 Approved`
              : `\u2717 Rejected`}
          </p>
          {decision.resolved_at && (
            <p className="mt-0.5 font-mono text-[10px] text-text-muted">
              {timeAgo(decision.resolved_at)}
            </p>
          )}
        </div>
      )}

      {/* Timestamp */}
      <p className="mt-3 font-mono text-[10px] text-text-muted">
        {timeAgo(decision.created_at)}
      </p>
    </motion.div>
  );
}
