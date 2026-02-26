"use client";

import {
  Eye,
  File,
  Database,
  Globe,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Json } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ShadowReportProps {
  report: Json | null;
}

// ---------------------------------------------------------------------------
// Safe JSONB
// ---------------------------------------------------------------------------

type JsonObj = Record<string, Json>;

function asObj(val: Json | null | undefined): JsonObj | null {
  if (val && typeof val === "object" && !Array.isArray(val)) return val as JsonObj;
  return null;
}

function asArr(val: Json | null | undefined): Json[] {
  if (Array.isArray(val)) return val;
  return [];
}

function asStr(val: Json | null | undefined): string {
  if (typeof val === "string") return val;
  return "";
}

function asNum(val: Json | null | undefined): number {
  if (typeof val === "number") return val;
  return 0;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function WriteItem({ item }: { item: Json }) {
  const o = asObj(item);
  const type = asStr(o?.type);
  const Icon = type === "db_row" ? Database : File;
  const path = asStr(o?.path);
  const count = asNum(o?.count);
  const table = asStr(o?.table);

  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
      <div className="min-w-0 flex-1">
        {type === "db_row" ? (
          <span className="font-mono text-xs text-text-secondary">
            {count} rows → <span className="text-text-muted">{table}</span>
          </span>
        ) : (
          <span className="font-mono text-xs text-text-secondary">
            {path || "file"}
          </span>
        )}
      </div>
    </div>
  );
}

function SendItem({ item }: { item: Json }) {
  const o = asObj(item);
  const method = asStr(o?.method).toUpperCase() || "GET";
  const endpoint = asStr(o?.endpoint);
  const count = asNum(o?.count);

  const methodColor =
    method === "POST" || method === "PUT"
      ? "bg-warning/20 text-warning"
      : method === "DELETE"
        ? "bg-error/20 text-error"
        : "bg-accent/20 text-accent";

  return (
    <div className="flex items-start gap-2">
      <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded px-1 py-0.5 font-mono text-[9px] font-medium",
            methodColor
          )}
        >
          {method}
        </span>
        <span className="font-mono text-xs text-text-secondary">
          {endpoint || "external API"}
        </span>
        {count > 1 && (
          <span className="font-mono text-[10px] text-text-muted">
            x{count}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ShadowReport({ report }: ShadowReportProps) {
  const obj = asObj(report);

  if (!obj) {
    return (
      <div className="rounded-lg border border-border-primary bg-bg-surface p-4">
        <div className="flex items-center gap-2">
          <Eye className="h-4 w-4 text-text-muted" />
          <h3 className="font-heading text-base text-text-primary">
            Shadow Report
          </h3>
        </div>
        <p className="mt-2 font-body text-xs text-text-muted italic">
          No shadow report available. Run a shadow execution first.
        </p>
      </div>
    );
  }

  const wouldWrite = asArr(obj.would_write);
  const wouldSend = asArr(obj.would_send);
  const dataProcessed = asObj(obj.data_processed);
  const execTime = asNum(obj.execution_time_ms);
  const errors = asArr(obj.errors);

  const totalItems = asNum(dataProcessed?.total_items);
  const sampleSize = asNum(dataProcessed?.sample_size);

  return (
    <div className="rounded-lg border border-border-primary bg-bg-surface p-4">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2">
        <Eye className="h-4 w-4 text-text-muted" />
        <h3 className="font-heading text-base text-text-primary">
          Shadow Report
        </h3>
      </div>
      <p className="mb-4 font-body text-xs text-text-muted">
        What would happen if this ran
      </p>

      <div className="space-y-4">
        {/* Would Write */}
        {wouldWrite.length > 0 && (
          <div>
            <p className="mb-1.5 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              Would Write
            </p>
            <div className="space-y-1.5">
              {wouldWrite.map((item, i) => (
                <WriteItem key={i} item={item} />
              ))}
            </div>
          </div>
        )}

        {/* Would Send */}
        {wouldSend.length > 0 && (
          <div>
            <p className="mb-1.5 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              Would Send
            </p>
            <div className="space-y-1.5">
              {wouldSend.map((item, i) => (
                <SendItem key={i} item={item} />
              ))}
            </div>
          </div>
        )}

        {wouldSend.length === 0 && (
          <p className="font-body text-xs text-text-muted">
            0 external requests
          </p>
        )}

        {/* Data Processed */}
        {dataProcessed && totalItems > 0 && (
          <div>
            <p className="mb-1 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              Data Processed
            </p>
            <p className="font-mono text-xs text-text-secondary">
              {totalItems} items
              {sampleSize > 0 && ` (sample of ${sampleSize} shown)`}
            </p>
          </div>
        )}

        {/* Execution Time */}
        {execTime > 0 && (
          <p className="font-mono text-xs text-text-muted">
            Completed in {execTime}ms
          </p>
        )}

        {/* Errors */}
        {errors.length > 0 && (
          <div>
            <p className="mb-1 font-body text-[10px] font-semibold uppercase tracking-widest text-error">
              Errors
            </p>
            {errors.map((err, i) => (
              <div key={i} className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" />
                <span className="font-mono text-xs text-error">
                  {asStr(err) || "Unknown error"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
