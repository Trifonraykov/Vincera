"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Brain,
  Search,
  GraduationCap,
  Hammer,
  Activity,
  BarChart3,
  Zap,
  Lightbulb,
  Pause,
  Play,
  Download,
  Power,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { cardEntrance, staggerChildren, breathe } from "@/lib/animations";
import { cn, truncate } from "@/lib/utils";
import type {
  Company,
  AgentStatus,
  Automation,
  Metric,
  ResearchSource,
  ResearchInsight,
  Json,
} from "@/lib/supabase";
import AutomationTable from "@/components/automations/AutomationTable";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { useDashboard } from "@/contexts/DashboardContext";
import { AnimatePresence } from "framer-motion";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tab =
  | "overview"
  | "environment"
  | "agents"
  | "automations"
  | "research"
  | "metrics"
  | "settings";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "environment", label: "Environment" },
  { key: "agents", label: "Agents" },
  { key: "automations", label: "Automations" },
  { key: "research", label: "Research" },
  { key: "metrics", label: "Metrics" },
  { key: "settings", label: "Settings" },
];

// ---------------------------------------------------------------------------
// JSONB helpers
// ---------------------------------------------------------------------------

type JsonObj = Record<string, Json>;

function asObj(val: Json | null | undefined): JsonObj | null {
  if (val && typeof val === "object" && !Array.isArray(val))
    return val as JsonObj;
  return null;
}

function asArr(val: Json | null | undefined): Json[] {
  return Array.isArray(val) ? val : [];
}

function asStr(val: Json | null | undefined): string {
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return "";
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CompanyTabsProps {
  company: Company | null;
  companyId: string;
  agentStatuses: AgentStatus[];
  automations: Automation[];
  metrics: Metric[];
  researchSources: ResearchSource[];
  researchInsights: ResearchInsight[];
  onUpdateAutomationStatus: (id: string, status: string) => Promise<void>;
  onDeleteAutomation: (id: string) => Promise<void>;
  onExportData: (companyName: string) => Promise<void>;
  onDisconnect: (companyId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent grid (inlined, follows AgentGridCard pattern)
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  orchestrator: Brain,
  discovery: Search,
  research: GraduationCap,
  builder: Hammer,
  operator: Activity,
  analyst: BarChart3,
  unstuck: Zap,
  trainer: Lightbulb,
};

const AGENT_NAMES = [
  "orchestrator",
  "discovery",
  "research",
  "builder",
  "operator",
  "analyst",
  "unstuck",
  "trainer",
];

function AgentCell({
  name,
  status,
}: {
  name: string;
  status?: AgentStatus;
}) {
  const Icon = ICON_MAP[name] ?? Brain;
  const isRunning = status?.status === "running";
  const statusLabel = status?.status ?? "offline";

  return (
    <Link href={`/dashboard/agents/${name}`}>
      <motion.div
        variants={cardEntrance}
        whileHover={{ y: -1, borderColor: "#2A2A2A" }}
        className="group rounded-md border border-border-primary bg-bg-surface p-3 transition-colors"
      >
        <motion.div
          variants={isRunning ? breathe : undefined}
          animate={isRunning ? "animate" : undefined}
          className="flex items-center gap-2"
        >
          <Icon
            className={cn(
              "h-4 w-4 shrink-0",
              isRunning ? "text-accent" : "text-text-secondary"
            )}
          />
          <span className="flex-1 truncate font-body text-xs font-medium capitalize text-text-primary">
            {name}
          </span>
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
              isRunning
                ? "bg-accent animate-pulse"
                : statusLabel === "failed"
                  ? "bg-error"
                  : statusLabel === "paused" || statusLabel === "blocked"
                    ? "bg-warning"
                    : "bg-text-muted"
            )}
          />
        </motion.div>
        <p className="mt-1.5 truncate font-mono text-[10px] text-text-muted">
          {isRunning && status?.current_task
            ? truncate(status.current_task, 40)
            : statusLabel}
        </p>
      </motion.div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Source Card (simplified inline for Research tab)
// ---------------------------------------------------------------------------

function SourceRow({
  source,
  insights,
  isExpanded,
  onToggle,
}: {
  source: ResearchSource;
  insights: ResearchInsight[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const stars = Math.round(source.quality_score * 5);
  const hasUrl = source.url && source.url.trim().length > 0;

  return (
    <motion.div
      variants={cardEntrance}
      className="rounded-lg border border-border-primary bg-bg-surface p-4"
    >
      <h4 className="font-heading text-base text-text-primary">
        {source.title}
      </h4>
      {source.authors && (
        <p className="mt-0.5 font-body text-xs text-text-secondary">
          {source.authors}
          {source.year && ` \u00B7 ${source.year}`}
        </p>
      )}
      <div className="mt-1 flex items-center gap-3">
        <span className="text-xs">
          {Array.from({ length: 5 })
            .map((_, i) =>
              i < stars ? "\u2605" : "\u2606"
            )
            .join("")}
        </span>
        <span className="font-mono text-[10px] text-text-muted">
          {source.relevance_score.toFixed(2)} relevance
        </span>
        {hasUrl && (
          <a
            href={source.url!}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-0.5 font-body text-[10px] text-accent hover:underline"
          >
            View <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </div>
      {insights.length > 0 && (
        <button
          onClick={onToggle}
          className="mt-2 flex items-center gap-1 font-body text-xs text-text-secondary hover:text-text-primary"
        >
          {isExpanded ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
          {insights.length} insights
        </button>
      )}
      <AnimatePresence>
        {isExpanded && insights.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-1.5 border-t border-border-primary pt-2">
              {insights.map((ins) => (
                <div key={ins.id} className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                      ins.applied ? "bg-accent" : "bg-text-muted/40"
                    )}
                  />
                  <span className="font-body text-xs text-text-secondary">
                    {ins.insight}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px]",
                      ins.applied
                        ? "bg-accent/10 text-accent"
                        : "bg-bg-surface-raised text-text-muted"
                    )}
                  >
                    {ins.applied ? "applied" : "pending"}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// JSONB Section Renderer
// ---------------------------------------------------------------------------

function JsonSection({ label, data }: { label: string; data: Json }) {
  const arr = asArr(data);
  const obj = asObj(data);
  const str = asStr(data);

  if (arr.length > 0) {
    return (
      <div className="mb-4">
        <p className="mb-1.5 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {label}
        </p>
        <ul className="space-y-1">
          {arr.map((item, i) => {
            const text = typeof item === "string" ? item : asStr(asObj(item)?.name) || asStr(asObj(item)?.description) || JSON.stringify(item);
            return (
              <li
                key={i}
                className="font-body text-sm text-text-secondary"
              >
                &middot; {text}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  if (obj) {
    return (
      <div className="mb-4">
        <p className="mb-1.5 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {label}
        </p>
        {Object.entries(obj).map(([k, v]) => (
          <div key={k} className="mb-2">
            <span className="font-mono text-xs text-text-muted capitalize">
              {k.replace(/_/g, " ")}
            </span>
            {Array.isArray(v) ? (
              <div className="mt-0.5 flex flex-wrap gap-1.5">
                {v.map((item, i) => (
                  <span
                    key={i}
                    className="rounded-full bg-bg-surface-raised px-2 py-0.5 font-mono text-[11px] text-text-secondary"
                  >
                    {asStr(item)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="font-body text-sm text-text-secondary">
                {asStr(v)}
              </p>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (str) {
    return (
      <div className="mb-4">
        <p className="mb-1 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {label}
        </p>
        <p className="font-body text-sm text-text-secondary">{str}</p>
      </div>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Recharts tooltip style
// ---------------------------------------------------------------------------

const TOOLTIP_STYLE = {
  contentStyle: {
    background: "#111",
    border: "1px solid #1A1A1A",
    borderRadius: 6,
    fontSize: 11,
    fontFamily: "monospace",
  },
  labelStyle: { color: "#888" },
};

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CompanyTabs({
  company,
  companyId,
  agentStatuses,
  automations,
  metrics,
  researchSources,
  researchInsights,
  onUpdateAutomationStatus,
  onDeleteAutomation,
  onExportData,
  onDisconnect,
}: CompanyTabsProps) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [autoFilter, setAutoFilter] = useState("all");
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [disconnectLoading, setDisconnectLoading] = useState(false);
  const { isPaused, togglePause } = useDashboard();

  // Group insights by source
  const insightsBySource = useMemo(() => {
    const map: Record<string, ResearchInsight[]> = {};
    for (const ins of researchInsights) {
      const key = ins.source_id ?? "__orphan";
      if (!map[key]) map[key] = [];
      map[key].push(ins);
    }
    return map;
  }, [researchInsights]);

  // Metrics data for charts
  const hoursSavedData = useMemo(
    () =>
      metrics
        .filter((m) => m.metric_name === "hours_saved")
        .map((m) => ({ date: formatDate(m.metric_date), value: m.metric_value })),
    [metrics]
  );

  const tasksData = useMemo(
    () =>
      metrics
        .filter((m) => m.metric_name === "tasks_completed")
        .map((m) => ({ date: formatDate(m.metric_date), value: m.metric_value })),
    [metrics]
  );

  const decisionsData = useMemo(
    () =>
      metrics
        .filter((m) => m.metric_name === "decisions_made")
        .map((m) => ({ date: formatDate(m.metric_date), value: m.metric_value })),
    [metrics]
  );

  async function handleDisconnect() {
    setDisconnectLoading(true);
    await onDisconnect(companyId);
    setDisconnectLoading(false);
    setShowDisconnect(false);
  }

  // Metadata/config JSONB
  const meta = asObj(company?.metadata);
  const config = asObj(company?.config);

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-0.5 overflow-x-auto border-b border-border-primary">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={cn(
              "shrink-0 px-4 py-2.5 font-body text-sm transition-colors",
              activeTab === t.key
                ? "border-b-2 border-b-accent text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="mt-6">
        {/* ============================================================= */}
        {/* Overview Tab                                                    */}
        {/* ============================================================= */}
        {activeTab === "overview" && (
          <div>
            {meta ? (
              Object.entries(meta).map(([key, val]) => (
                <JsonSection key={key} label={key.replace(/_/g, " ")} data={val} />
              ))
            ) : (
              <p className="font-body text-sm text-text-muted italic">
                Company model will be generated after the discovery phase.
              </p>
            )}
            {config && Object.keys(config).length > 0 && (
              <div className="mt-6 border-t border-border-primary pt-4">
                <p className="mb-3 font-body text-xs font-semibold uppercase tracking-widest text-text-muted">
                  Configuration
                </p>
                {Object.entries(config).map(([key, val]) => (
                  <JsonSection key={key} label={key.replace(/_/g, " ")} data={val} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ============================================================= */}
        {/* Environment Tab                                                 */}
        {/* ============================================================= */}
        {activeTab === "environment" && (
          <div>
            {meta && (asObj(meta.software_stack) || asObj(meta.environment)) ? (
              <JsonSection
                label="Software Stack"
                data={meta.software_stack ?? meta.environment ?? null}
              />
            ) : meta ? (
              // Try rendering all metadata as environment info
              Object.entries(meta)
                .filter(([k]) =>
                  ["os", "databases", "languages", "tools", "services", "software_stack", "environment"].includes(k)
                )
                .map(([key, val]) => (
                  <JsonSection key={key} label={key.replace(/_/g, " ")} data={val} />
                ))
            ) : null}
            {(!meta ||
              !Object.keys(meta).some((k) =>
                ["os", "databases", "languages", "tools", "services", "software_stack", "environment"].includes(k)
              )) && (
              <p className="font-body text-sm text-text-muted italic">
                Environment data will populate after the discovery scan.
              </p>
            )}
          </div>
        )}

        {/* ============================================================= */}
        {/* Agents Tab                                                      */}
        {/* ============================================================= */}
        {activeTab === "agents" && (
          <motion.div
            variants={staggerChildren(0.04)}
            initial="hidden"
            animate="visible"
            className="grid grid-cols-2 gap-2 lg:grid-cols-4"
          >
            {AGENT_NAMES.map((name) => {
              const statusMap = new Map<string, AgentStatus>();
              agentStatuses.forEach((s) => statusMap.set(s.agent_name, s));
              return (
                <AgentCell
                  key={name}
                  name={name}
                  status={statusMap.get(name)}
                />
              );
            })}
          </motion.div>
        )}

        {/* ============================================================= */}
        {/* Automations Tab                                                 */}
        {/* ============================================================= */}
        {activeTab === "automations" && (
          <div>
            <div className="mb-4 flex flex-wrap gap-1">
              {["all", "shadow", "canary", "active", "paused", "failed"].map(
                (f) => (
                  <button
                    key={f}
                    onClick={() => setAutoFilter(f)}
                    className={cn(
                      "rounded-full px-3 py-1.5 font-body text-xs transition-colors",
                      autoFilter === f
                        ? "bg-bg-surface-raised text-text-primary"
                        : "text-text-secondary hover:text-text-primary"
                    )}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                )
              )}
            </div>
            <AutomationTable
              automations={automations}
              filter={autoFilter}
              onUpdateStatus={onUpdateAutomationStatus}
              onDelete={onDeleteAutomation}
            />
          </div>
        )}

        {/* ============================================================= */}
        {/* Research Tab                                                     */}
        {/* ============================================================= */}
        {activeTab === "research" && (
          <div>
            {/* Stats */}
            <div className="mb-4 flex gap-4">
              <span className="font-mono text-xs text-text-secondary">
                <span className="text-text-primary">
                  {researchSources.length}
                </span>{" "}
                sources
              </span>
              <span className="font-mono text-xs text-text-secondary">
                <span className="text-text-primary">
                  {researchInsights.length}
                </span>{" "}
                insights
              </span>
              <span className="font-mono text-xs text-text-secondary">
                <span className="text-accent">
                  {researchInsights.filter((i) => i.applied).length}
                </span>{" "}
                applied
              </span>
            </div>

            {researchSources.length > 0 ? (
              <motion.div
                variants={staggerChildren(0.04)}
                initial="hidden"
                animate="visible"
                className="space-y-3"
              >
                {researchSources.map((s) => (
                  <SourceRow
                    key={s.id}
                    source={s}
                    insights={insightsBySource[s.id] ?? []}
                    isExpanded={expandedSourceId === s.id}
                    onToggle={() =>
                      setExpandedSourceId(
                        expandedSourceId === s.id ? null : s.id
                      )
                    }
                  />
                ))}
              </motion.div>
            ) : (
              <p className="py-8 text-center font-body text-sm text-text-muted italic">
                No research sources yet.
              </p>
            )}
          </div>
        )}

        {/* ============================================================= */}
        {/* Metrics Tab                                                     */}
        {/* ============================================================= */}
        {activeTab === "metrics" && (
          <div>
            {metrics.length === 0 ? (
              <p className="py-12 text-center font-body text-sm text-text-muted italic">
                Metrics will appear after the first full day of operation.
              </p>
            ) : (
              <div className="space-y-6">
                {/* Hours Saved */}
                {hoursSavedData.length > 0 && (
                  <div className="rounded-lg border border-border-primary bg-bg-surface p-5">
                    <p className="mb-3 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                      Hours Saved Over Time
                    </p>
                    <ResponsiveContainer width="100%" height={250}>
                      <AreaChart data={hoursSavedData}>
                        <defs>
                          <linearGradient
                            id="hoursGrad"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop
                              offset="0%"
                              stopColor="#00FF88"
                              stopOpacity={0.3}
                            />
                            <stop
                              offset="100%"
                              stopColor="#00FF88"
                              stopOpacity={0}
                            />
                          </linearGradient>
                        </defs>
                        <XAxis
                          dataKey="date"
                          tick={{
                            fill: "#555",
                            fontSize: 10,
                            fontFamily: "monospace",
                          }}
                          axisLine={{ stroke: "#1A1A1A" }}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{
                            fill: "#555",
                            fontSize: 10,
                            fontFamily: "monospace",
                          }}
                          axisLine={false}
                          tickLine={false}
                          width={30}
                        />
                        <Tooltip
                          {...TOOLTIP_STYLE}
                          itemStyle={{ color: "#00FF88" }}
                        />
                        <Area
                          type="monotone"
                          dataKey="value"
                          stroke="#00FF88"
                          fill="url(#hoursGrad)"
                          strokeWidth={1.5}
                          name="Hours"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Tasks Completed */}
                {tasksData.length > 0 && (
                  <div className="rounded-lg border border-border-primary bg-bg-surface p-5">
                    <p className="mb-3 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                      Tasks Completed Over Time
                    </p>
                    <ResponsiveContainer width="100%" height={250}>
                      <BarChart data={tasksData}>
                        <XAxis
                          dataKey="date"
                          tick={{
                            fill: "#555",
                            fontSize: 10,
                            fontFamily: "monospace",
                          }}
                          axisLine={{ stroke: "#1A1A1A" }}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{
                            fill: "#555",
                            fontSize: 10,
                            fontFamily: "monospace",
                          }}
                          axisLine={false}
                          tickLine={false}
                          width={30}
                        />
                        <Tooltip
                          {...TOOLTIP_STYLE}
                          itemStyle={{ color: "#888" }}
                        />
                        <Bar
                          dataKey="value"
                          fill="#888888"
                          radius={[2, 2, 0, 0]}
                          name="Tasks"
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Decisions Made */}
                {decisionsData.length > 0 && (
                  <div className="rounded-lg border border-border-primary bg-bg-surface p-5">
                    <p className="mb-3 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                      Decisions Made Over Time
                    </p>
                    <ResponsiveContainer width="100%" height={250}>
                      <LineChart data={decisionsData}>
                        <XAxis
                          dataKey="date"
                          tick={{
                            fill: "#555",
                            fontSize: 10,
                            fontFamily: "monospace",
                          }}
                          axisLine={{ stroke: "#1A1A1A" }}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{
                            fill: "#555",
                            fontSize: 10,
                            fontFamily: "monospace",
                          }}
                          axisLine={false}
                          tickLine={false}
                          width={30}
                        />
                        <Tooltip
                          {...TOOLTIP_STYLE}
                          itemStyle={{ color: "#FFB800" }}
                        />
                        <Line
                          type="monotone"
                          dataKey="value"
                          stroke="#FFB800"
                          strokeWidth={1.5}
                          dot={{ fill: "#FFB800", r: 2 }}
                          name="Decisions"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ============================================================= */}
        {/* Settings Tab                                                    */}
        {/* ============================================================= */}
        {activeTab === "settings" && (
          <div className="space-y-6">
            {/* Ghost Mode */}
            <div className="rounded-lg border border-border-primary bg-bg-surface p-5">
              <p className="mb-2 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                Ghost Mode
              </p>
              {company?.status === "ghost" ? (
                <p className="font-body text-sm text-text-secondary">
                  Ghost mode is currently{" "}
                  <span className="text-accent">active</span>.
                  {company?.ghost_mode_until && (
                    <span className="ml-1 font-mono text-xs text-text-muted">
                      Ends:{" "}
                      {new Date(company!.ghost_mode_until!).toLocaleDateString()}
                    </span>
                  )}
                </p>
              ) : (
                <p className="font-body text-sm text-text-muted">
                  Ghost mode is not active.
                </p>
              )}
            </div>

            {/* Pause / Resume */}
            <div className="rounded-lg border border-border-primary bg-bg-surface p-5">
              <p className="mb-3 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                System Controls
              </p>
              <div className="flex items-center gap-4">
                <button
                  onClick={togglePause}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-4 py-2 font-body text-sm font-medium transition-colors",
                    isPaused
                      ? "border-accent bg-accent/10 text-accent hover:bg-accent/20"
                      : "border-warning bg-warning/10 text-warning hover:bg-warning/20"
                  )}
                >
                  {isPaused ? (
                    <>
                      <Play className="h-4 w-4" /> Resume System
                    </>
                  ) : (
                    <>
                      <Pause className="h-4 w-4" /> Pause System
                    </>
                  )}
                </button>
                <span
                  className={cn(
                    "font-mono text-xs",
                    isPaused ? "text-warning" : "text-accent"
                  )}
                >
                  {isPaused ? "System paused" : "System active"}
                </span>
              </div>
            </div>

            {/* Model Info */}
            <div className="rounded-lg border border-border-primary bg-bg-surface p-5">
              <p className="mb-2 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                Model Configuration
              </p>
              <p className="font-mono text-xs text-text-secondary">
                Primary: claude-opus via OpenRouter
              </p>
              <p className="font-mono text-xs text-text-muted">
                Agents: claude-sonnet via OpenRouter
              </p>
            </div>

            {/* Export Data */}
            <div className="rounded-lg border border-border-primary bg-bg-surface p-5">
              <p className="mb-3 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                Data Export
              </p>
              <button
                onClick={() => onExportData(company?.name ?? "company")}
                className="flex items-center gap-2 rounded-md border border-border-primary px-4 py-2 font-body text-sm text-text-secondary transition-colors hover:border-border-hover hover:text-text-primary"
              >
                <Download className="h-4 w-4" /> Export Company Data
              </button>
              <p className="mt-1.5 font-mono text-[10px] text-text-muted">
                Downloads all data as a JSON file.
              </p>
            </div>

            {/* Disconnect */}
            <div className="border-t border-border-primary pt-6">
              <div className="rounded-lg border border-border-primary bg-bg-surface p-5">
                <p className="mb-3 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                  Danger Zone
                </p>
                <button
                  onClick={() => setShowDisconnect(true)}
                  className="flex items-center gap-2 rounded-md border border-error/30 bg-error/5 px-4 py-2 font-body text-sm text-error transition-colors hover:bg-error/10"
                >
                  <Power className="h-4 w-4" /> Disconnect Company
                </button>
                <p className="mt-1.5 font-mono text-[10px] text-text-muted">
                  Stops all agents and automations. Data is preserved.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Disconnect modal */}
      <ConfirmModal
        isOpen={showDisconnect}
        onClose={() => setShowDisconnect(false)}
        onConfirm={handleDisconnect}
        title={`Disconnect ${company?.name ?? "company"}?`}
        description={
          <>
            This will stop all agents and automations for this company. Your
            data will be preserved but the system will stop running. To
            reconnect, re-run the Vincera installer on the target machine.
          </>
        }
        confirmLabel="Disconnect"
        confirmVariant="danger"
        isLoading={disconnectLoading}
      />
    </div>
  );
}
