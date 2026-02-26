"use client";

import { useState, useRef, useCallback } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChatInputProps {
  companyId: string;
  agentName: string;
  disabled?: boolean;
  onSend: (content: string) => Promise<void>;
}

const MAX_LENGTH = 5000;
const WARN_LENGTH = 4000;
const SHOW_COUNT_LENGTH = 2000;

export default function ChatInput({
  agentName,
  disabled,
  onSend,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isSending, setIsSending] = useState(false);

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || disabled || isSending || trimmed.length > MAX_LENGTH) return;
    setIsSending(true);
    setValue("");
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    try {
      await onSend(trimmed);
    } finally {
      setIsSending(false);
    }
  }, [value, disabled, isSending, onSend]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value);
    // Auto-resize
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  const showCount = value.length > SHOW_COUNT_LENGTH;
  const isWarn = value.length > WARN_LENGTH;
  const isOver = value.length > MAX_LENGTH;

  return (
    <div
      className={cn(
        "relative border-t bg-bg-surface px-4 py-3",
        disabled ? "border-warning/40" : "border-border-primary"
      )}
    >
      {disabled && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-surface/80">
          <span className="font-body text-sm text-warning">System is paused</span>
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={`Message ${agentName}...`}
          rows={1}
          className="max-h-40 flex-1 resize-none bg-transparent font-body text-sm text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-50"
        />

        {value.trim().length > 0 && (
          <button
            onClick={handleSubmit}
            disabled={disabled || isSending || isOver}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-black transition-opacity hover:opacity-80 disabled:opacity-30"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>

      {showCount && (
        <p
          className={cn(
            "mt-1 text-right font-mono text-[10px]",
            isOver ? "text-error" : isWarn ? "text-warning" : "text-text-muted"
          )}
        >
          {value.length}/{MAX_LENGTH}
        </p>
      )}
    </div>
  );
}
