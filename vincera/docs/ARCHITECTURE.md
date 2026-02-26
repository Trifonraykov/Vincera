# Vincera Architecture

## System Overview

Vincera is a three-layer system: a Python agent that runs on the company's machine, a Supabase database that stores all state, and a Next.js dashboard that provides the user interface.

```
┌─────────────────────────────────────────────────┐
│              Next.js Dashboard                   │
│  (Agents, Brain View, Automations, Decisions,   │
│   Knowledge, Research, Ghost Mode, Logs)         │
└────────────────────┬────────────────────────────┘
                     │  Supabase Realtime + REST
                     ▼
┌─────────────────────────────────────────────────┐
│                 Supabase                         │
│  15 tables │ RLS policies │ Realtime │ Functions │
└────────────────────┬────────────────────────────┘
                     │  supabase-py (service role)
                     ▼
┌─────────────────────────────────────────────────┐
│              Vincera Agent (Python)              │
│  Orchestrator → 7 Agents → Verification →       │
│  Sandbox → Shadow → Canary → Full Deploy        │
└─────────────────────────────────────────────────┘
```

The agent runs as a system service (systemd, launchd, or NSSM). It connects to Supabase using the service role key, which bypasses RLS. The dashboard connects using the anon key, so RLS policies enforce company isolation.

## Communication Model

There are no webhooks, no direct connections between dashboard and agent, and no separate chat service. Everything flows through Supabase.

**Dashboard to Agent:** The user types a message in the dashboard chat. The dashboard inserts a row into `messages` with `sender = 'user'`. The agent's message poller (see `vincera/core/message_handler.py`) periodically queries for unread user messages and dispatches them to the appropriate agent.

**Agent to Dashboard:** Agents write to the `messages` table with their name as `sender`. The dashboard subscribes to `messages` via Supabase Realtime and displays new messages instantly.

**Status Updates:** Agents update `agent_statuses` on every lifecycle transition. The dashboard subscribes to this table via Realtime — agent status dots update live.

**Brain State:** The Orchestrator publishes its internal state (current phase, active tasks, ranked automations) to `brain_states`. The Brain View page subscribes to this table and visualizes the OODA loop in real time.

**Decisions:** When an agent needs user approval, it creates a row in `decisions`. The dashboard's Decisions page shows pending decisions with approve/reject buttons. The agent polls for resolution.

## Agent System

### Agent Lifecycle

All agents extend `BaseAgent` (see `vincera/agents/base.py`). The lifecycle is managed by the `execute()` method:

```
IDLE → RUNNING → COMPLETED (success)
                → FAILED    (error)
                → BLOCKED   (waiting for approval)
```

The `AgentStatus` enum defines these states. On each transition, the agent updates `agent_statuses` in Supabase via `GlobalState.update_agent_status()`.

**Error handling:** When `run()` raises a `VinceraError`, the agent sets status to FAILED, calls `_report_error()` to send an alert message and log an event, then re-raises. When `run()` raises any other exception, the agent wraps it in a `VinceraError` with the original traceback attached as context. Error reporting is wrapped in try/except to prevent cascade failures (see `vincera/agents/base.py`, `_report_error()`).

### The 8 Agents

#### Orchestrator
- **Class:** `Orchestrator` — `vincera/core/orchestrator.py`
- **Role:** Central decision-making brain. Runs an OODA loop via `run_cycle()`.
- **Brain state:** `OrchestratorState` (Pydantic model) — serialized to `brain_states` table, survives restarts.
- **Phases:** installing → discovering → researching → ghost → active
- **Active phase:** Uses `PriorityEngine` to rank automation candidates, dispatches agents via the `_agents` dict, saves brain state checkpoints.

#### Discovery
- **Class:** `DiscoveryAgent` — `vincera/agents/discovery.py`
- **Role:** Narrated system discovery. Scans filesystems, databases, networks, spreadsheets.
- **Dependencies:** `SystemScanner`, `FilesystemMapper`, `DatabaseDiscovery`, `NetworkDiscovery`, `SpreadsheetScanner`, `CompanyModelBuilder`
- **Output:** Company model stored as knowledge, narration streamed as messages.
- **Files:** `vincera/discovery/` — scanner.py, filesystem.py, database.py, network.py, spreadsheet.py, company_model.py

#### Research
- **Class:** `ResearchAgent` — `vincera/agents/research.py`
- **Role:** Finds academic papers, industry reports, case studies relevant to the business.
- **Dependencies:** `BusinessResearcher`, `SourceValidator`, `KnowledgeExtractor`
- **Output:** Validated sources in `research_sources`, extracted insights in `research_insights`, applicable knowledge in `knowledge`.
- **Files:** `vincera/research/` — researcher.py, source_validator.py, knowledge_extractor.py

#### Builder
- **Class:** `BuilderAgent` — `vincera/agents/builder.py`
- **Role:** Generates automation scripts, reviews them, tests them, deploys through the pipeline.
- **Dependencies:** `CodeGenerator`, `CodeReviewer`, `TestGenerator`, `DockerSandbox`, `DeploymentPipeline`
- **Process:** Generate code → review → generate tests → sandbox execution → shadow run → canary → full deployment. Up to `MAX_ITERATIONS = 3` review-fix cycles.
- **Files:** `vincera/builder/` — code_generator.py, code_reviewer.py, test_generator.py

#### Operator
- **Class:** `OperatorAgent` — `vincera/agents/operator.py`
- **Role:** Runs scheduled automations, monitors health, manages canary deployments.
- **Dependencies:** `DockerSandbox`, `DeploymentMonitor`, `CanaryExecutor`, `DeploymentPipeline`
- **Tasks:** Execute scheduled runs, watch canary metrics, auto-heal on failure.

#### Analyst
- **Class:** `AnalystAgent` — `vincera/agents/analyst.py`
- **Role:** Evaluates automation performance, identifies optimization opportunities.
- **Dependencies:** `PriorityEngine`, `DeploymentMonitor`
- **Output:** `AnalysisReport` (performance, optimization, trend types). Writes findings to `events` and `metrics`.

#### Unstuck
- **Class:** `UnstuckAgent` — `vincera/agents/unstuck.py`
- **Role:** Diagnoses failures and blocked agents, proposes fixes.
- **Output:** `DiagnosisResult` with problem_type (code_error, timeout, resource_limit, dependency_failure, permission_denied, data_issue, unknown), root cause, and recommended fix.
- **Process:** Diagnose → generate fix script → sandbox test → report.

#### Trainer
- **Class:** `TrainerAgent` — `vincera/agents/trainer.py`
- **Role:** Processes user corrections, builds playbook entries, identifies cross-company patterns.
- **Dependencies:** `CorrectionTracker`, `TrainingEngine`
- **Output:** Updated agent instructions, playbook entries, cross-company patterns.
- **Files:** `vincera/training/` — corrections.py, trainer.py

### Authority Levels

Authority is managed by `AuthorityManager` (see `vincera/core/authority.py`). Each company has an `authority_level` that determines what agents may do without asking.

**Authority Levels** (from most restrictive to most permissive):

| Level | Behavior |
|-------|----------|
| `OBSERVER` | Agent watches only, never acts |
| `SUGGEST` | Agent suggests actions, never executes |
| `ASK_ALWAYS` | Agent asks for approval before every action |
| `ASK_RISKY` | Agent acts silently on safe/low-risk; asks on medium+ |
| `ASK_HIGH_ONLY` | Agent asks only for high/critical risk actions |
| `AUTONOMOUS` | Agent acts on everything except critical risk |

**Action Risk Levels:**

| Risk | Examples |
|------|----------|
| `SAFE` | Reading files, querying data |
| `LOW` | Writing to agent's own workspace |
| `MEDIUM` | Sending messages, creating knowledge entries |
| `HIGH` | Deploying automations, modifying company config |
| `CRITICAL` | Deleting data, external API calls, system changes |

When an action requires approval, the agent creates a `decisions` row and blocks until the user responds via the dashboard.

### Verification Pipeline

Every significant agent action passes through the `Verifier` (see `vincera/verification/verifier.py`). The pipeline runs 6 sequential checks:

1. **Fact Check** (`verification/fact_checker.py: fact_check()`) — verifies claims against known data sources
2. **No Fabrication** (`verification/fact_checker.py: no_fabrication()`) — flags unsourced claims and invented data
3. **Reversibility** (`verification/safety.py: reversibility_check()`) — blocks destructive operations (DELETE, DROP, rm -rf, external HTTP, SMTP)
4. **Idempotency** (`verification/safety.py: idempotency_check()`) — ensures the action can be safely re-run
5. **Effectiveness** (`verifier.py: _effectiveness_check()`) — validates the action achieves its stated goal
6. **Authority** (`verifier.py: _authority_check()`) — confirms the action is within the agent's authority level

**Confidence scoring:** `verification/confidence.py: calculate_confidence()` produces a 0.0–1.0 score. Deductions apply for failed checks, missing data sources, and high complexity. Actions with confidence < 0.7 are blocked and escalated.

**High-stakes verification:** For high-risk actions, two independent Claude calls evaluate the same action. Both must agree for the action to proceed (see `verification/verifier.py: verify_high_stakes()`).

## Execution Engine

Automations pass through a 4-stage deployment pipeline before reaching production.

### Sandbox

`DockerSandbox` (see `vincera/execution/sandbox.py`) executes scripts in an isolated Docker container. Returns `SandboxResult` with exit code, stdout/stderr, execution time, and resource usage. Falls back to subprocess execution if Docker is unavailable.

### Shadow Execution

`ShadowExecutor` (see `vincera/execution/shadow.py`) runs scripts against real data but intercepts all write operations. Returns `ShadowResult` with what the script would have produced, side effects detected, data accessed, data it would modify, and a recommendation (promote/retry/fix/reject).

### Canary Deployment

`CanaryExecutor` (see `vincera/execution/canary.py`) runs the automation on a subset of traffic. Tracks `CanaryExecution` records with success/failure per run. The canary scales from 10% to 100% as confidence builds.

### Deployment Pipeline

`DeploymentPipeline` (see `vincera/execution/deployment_pipeline.py`) orchestrates the full flow:

```
sandbox → shadow → canary → full
```

Each stage gate requires verification to pass. The pipeline tracks a `DeploymentRecord` through stages: SANDBOX → SHADOW → CANARY → FULL (or ROLLED_BACK on failure).

### Monitoring and Rollback

`DeploymentMonitor` (see `vincera/execution/monitor.py`) watches running automations for health metrics. `RollbackManager` (see `vincera/execution/rollback.py`) reverts automations to their previous state on failure.

## Data Layer

### Supabase Schema

All tables use UUID primary keys with `gen_random_uuid()`. Foreign keys reference `companies(id)` with `ON DELETE CASCADE`. All timestamps use `TIMESTAMPTZ` with `DEFAULT now()`.

#### companies
Central registry of companies using Vincera.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| name | TEXT | |
| industry | TEXT | |
| business_type | TEXT | |
| status | TEXT | installing, ghost, active, paused |
| authority_level | TEXT | observer, suggest, ask_always, ask_risky, ask_high_only, autonomous |
| ghost_mode_until | TIMESTAMPTZ | |
| agent_name | TEXT | |
| config | JSONB | |
| metadata | JSONB | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | Auto-updated via trigger |

#### agent_statuses
Current state of each agent per company. **Realtime enabled.**

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| agent_name | TEXT | |
| status | TEXT | idle, running, completed, failed, blocked |
| current_task | TEXT | |
| last_run | TIMESTAMPTZ | |
| error_message | TEXT | |
| metadata | JSONB | |
| UNIQUE | | (company_id, agent_name) |

#### automations
Each automation Vincera discovers, builds, and operates. **Realtime enabled.**

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| name | TEXT | |
| description | TEXT | |
| domain | TEXT | finance, sales, operations, etc. |
| status | TEXT | pending, sandbox, shadow, canary, full, rolled_back, failed |
| deployment_id | TEXT | |
| script | TEXT | |
| expected_behavior | TEXT | |
| sandbox_result | JSONB | |
| shadow_result | JSONB | |
| canary_result | JSONB | |
| schedule | TEXT | Cron expression |
| last_run | TIMESTAMPTZ | |
| run_count | INTEGER | |
| success_count | INTEGER | |
| failure_count | INTEGER | |

#### events
Append-only activity log. **Realtime enabled.**

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| event_type | TEXT | action, error, decision, deployment, system |
| agent_name | TEXT | |
| message | TEXT | |
| severity | TEXT | debug, info, warning, error, critical |
| metadata | JSONB | |
| created_at | TIMESTAMPTZ | Append-only |

Retention: `clean_old_events()` function removes records older than 90 days.

#### messages
Core communication channel between dashboard and agents. **Realtime enabled.**

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| sender | TEXT | user, orchestrator, builder, system, etc. |
| content | TEXT | |
| message_type | TEXT | chat, system, command, correction, decision_request, decision_response |
| metadata | JSONB | |
| read | BOOLEAN | |
| created_at | TIMESTAMPTZ | |

Dashboard subscribes for `sender != 'user'`. Agent polls for `sender = 'user'`. RLS restricts users to inserting/deleting only rows with `sender = 'user'`.

#### knowledge
Discovered facts and business rules. **Realtime enabled.**

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| category | TEXT | process, tool, integration, business_rule, discovery |
| title | TEXT | |
| content | TEXT | |
| source | TEXT | Which agent created it |
| tags | TEXT[] | |
| relevance_score | FLOAT | |
| metadata | JSONB | |

Index: GIN index on `tags` for array containment queries.

#### decisions
Agent approval requests. **Realtime enabled.**

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| agent_name | TEXT | |
| question | TEXT | |
| option_a | TEXT | |
| option_b | TEXT | |
| context | TEXT | |
| risk_level | TEXT | low, medium, high |
| resolution | TEXT | NULL until resolved, then option_a or option_b |
| resolved_at | TIMESTAMPTZ | |
| expires_at | TIMESTAMPTZ | |

#### playbook_entries
Agent memory of what worked and what didn't.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| agent_name | TEXT | |
| task | TEXT | |
| description | TEXT | |
| action_taken | TEXT | |
| outcome | TEXT | |
| success | BOOLEAN | |
| notes | TEXT | |
| similarity_tags | TEXT[] | GIN indexed |
| run_count | INTEGER | |
| last_used | TIMESTAMPTZ | |

#### corrections
User corrections to agent behavior. Consumed by the Trainer agent.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| agent_name | TEXT | |
| original_action | TEXT | |
| correction_text | TEXT | |
| corrected_action | TEXT | |
| category | TEXT | output_format, logic_error, wrong_data, wrong_approach, tone, scope, other |
| severity | TEXT | minor, moderate, major, critical |
| applied | BOOLEAN | |
| applied_at | TIMESTAMPTZ | |
| tags | TEXT[] | |

#### research_sources
Academic papers, industry reports, and case studies.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| title | TEXT | |
| authors | TEXT | |
| source_type | TEXT | academic_paper, industry_report, case_study, best_practice_guide |
| url | TEXT | |
| publication | TEXT | |
| year | INTEGER | |
| relevance_score | FLOAT | |
| quality_score | FLOAT | |
| summary | TEXT | |
| key_insights | JSONB | |
| applicable_processes | JSONB | |

#### research_insights
Extracted insights from research sources.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| source_id | UUID FK | References research_sources, ON DELETE SET NULL |
| insight | TEXT | |
| category | TEXT | operations, finance, hr, sales, supply_chain, customer_service, marketing, compliance, it |
| actionability | TEXT | immediately_actionable, strategic, informational |
| applied | BOOLEAN | |
| how_to_apply | TEXT | |

#### brain_states
Serialized orchestrator state snapshots. **Realtime enabled.**

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| state | JSONB | Full OrchestratorState serialized |
| checkpoint_reason | TEXT | |
| created_at | TIMESTAMPTZ | |

Used for crash recovery (Orchestrator loads latest on restart) and live Brain View visualization.

#### ghost_reports
Daily observation reports during Ghost Mode.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| report_date | DATE | |
| observed_processes | JSONB | |
| would_have_automated | JSONB | |
| estimated_hours_saved | FLOAT | |
| estimated_tasks_automated | INTEGER | |
| key_observations | JSONB | |

#### metrics
Daily numeric KPIs.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| metric_name | TEXT | |
| metric_value | FLOAT | |
| metric_date | DATE | |
| tags | JSONB | |
| UNIQUE | | (company_id, metric_name, metric_date) |

`increment_metric()` function provides upsert behavior for daily counters.

#### cross_company_patterns
Anonymized patterns shared across deployments.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | UUID FK | |
| pattern_type | TEXT | automation_success, common_pain_point, best_practice |
| industry | TEXT | |
| business_type | TEXT | |
| description | TEXT | |
| frequency | INTEGER | |
| success_rate | FLOAT | |
| anonymized | BOOLEAN | |

### Row Level Security

All 15 tables have RLS enabled (see `supabase/migrations/015_rls_policies.sql`). The standard policy pattern:

```sql
CREATE POLICY "table_select" ON table_name
  FOR SELECT USING (company_id = auth.uid()::uuid);
```

The `messages` table has additional restrictions: users can only INSERT and DELETE rows where `sender = 'user'`.

The agent connects with the **service role key**, which bypasses RLS entirely. The dashboard connects with the **anon key**, which enforces RLS — each user only sees their own company's data.

### Realtime Subscriptions

Seven tables have Realtime enabled:

| Table | Dashboard Subscriber | What It Drives |
|-------|---------------------|----------------|
| agent_statuses | `useAgentStatus` hook + `DashboardContext` | Agent status dots, agent grid |
| automations | `useAutomations` hook | Automation table updates |
| events | `useActivityFeed` hook | Activity feed |
| messages | `useActivityFeed` hook | Chat messages, activity |
| decisions | `useDecisions` hook + `DashboardContext` | Decision badges, approval cards |
| knowledge | `useKnowledge` hook | Knowledge table |
| brain_states | `useBrainState` hook | Brain View visualization |

### Database Functions

Defined in `supabase/migrations/017_functions.sql`:

- `update_updated_at()` — trigger function auto-updating `updated_at` on row changes. Applied to companies, agent_statuses, automations, knowledge, playbook_entries.
- `increment_metric(company_id, metric_name, increment, date)` — upsert for daily metrics.
- `clean_old_events(days_to_keep DEFAULT 90)` — retention cleanup for the events table.
- `get_latest_brain_state(company_id)` — returns the most recent brain state snapshot.

### Local Storage

The agent also maintains local state:

- `~/VinceraHQ/` — home directory with subdirectories: core, agents, scripts, knowledge, inbox, outbox, logs, deployments, training
- SQLite database (via `vincera/utils/db.py`) for token usage tracking (`token_usage` table with model, tokens_in, tokens_out, cost_estimate, agent_name)
- JSON-lines log files with daily rotation in `~/VinceraHQ/logs/`

## Dashboard

### Design System

The dashboard follows a monochrome aesthetic:

- **Background:** `#000000` (black)
- **Text:** `#FFFFFF` (white)
- **Accent:** `#00FF88` (neon green)
- **Fonts:** Serif for headings, monospace for data/code, sans-serif for UI elements
- **Effects:** Grain overlay texture, particle canvas background (`ParticleCanvas.tsx`), Framer Motion page transitions

### Pages

| Route | Component | Purpose |
|-------|-----------|---------|
| `/dashboard` | Overview | Metrics, agent summary, activity feed |
| `/dashboard/agents` | Agent grid | 8 agent cards with status, uptime |
| `/dashboard/agents/[agent]` | Agent detail | Chat interface per agent |
| `/dashboard/brain` | Brain View | OODA indicator, thinking panel, priority queue, decision timeline |
| `/dashboard/automations` | Automation table | Status filters, schedule, metrics |
| `/dashboard/automations/[id]` | Automation detail | Shadow report, promote flow |
| `/dashboard/decisions` | Decision cards | Approve/reject with context |
| `/dashboard/knowledge` | Knowledge base | Graph visualization, editable table |
| `/dashboard/research` | Research library | Source cards, expandable insights |
| `/dashboard/ghost` | Ghost Mode | Progress bar, daily report cards |
| `/dashboard/logs` | Log viewer | Filterable event log, expandable metadata, CSV export |
| `/dashboard/company/[id]` | Company profile | 7 tabs: overview, environment, agents, automations, research, metrics, settings |

### Hooks

All hooks accept `companyId: string | null` and return `{ isLoading, ...data }`:

| Hook | Data | Realtime |
|------|------|----------|
| `useActivityFeed` | Combined events + messages feed | Yes |
| `useAgentStatus` | Agent status array | Yes |
| `useAutomations` | Automations + updateStatus, deleteAutomation | Yes |
| `useBrainState` | Current state, history, cycle selection | Yes |
| `useCompanyProfile` | Company data + updateProfile | No |
| `useDecisions` | Pending/resolved + approve/reject | Yes |
| `useGhostReports` | Ghost mode daily reports | No |
| `useKnowledge` | Knowledge entries + search | No |
| `useLogs` | Paginated event log + loadMore | No |
| `useMessages` | Chat history + sendMessage | No |
| `useMetrics` | hoursSaved, tasksCompleted, activeAutomations | No |
| `useResearch` | Research sources | No |

### Global State

`DashboardContext` (`contexts/DashboardContext.tsx`) provides:

- `companyId` / `setCompanyId` — current company selection
- `company` — full company record
- `isPaused` / `togglePause()` — pause state
- `agentSummary` — { total, running, idle, failed }
- `agentStatuses` — full status array
- `pendingDecisions` — count for badge
- `isConnected` — Supabase connection status

### Animation Library

`lib/animations.ts` exports Framer Motion variants:

- `pageTransition` — page enter/exit
- `cardEntrance` — card scale + fade
- `slideInRight` — slide-in from right
- `breathe` — pulsing opacity
- `pulseGlow` — glowing pulse
- `staggerChildren` — staggered child animations

All animations respect `prefers-reduced-motion`.

## Error Handling

### Exception Hierarchy

All custom exceptions inherit from `VinceraError` (see `vincera/utils/errors.py`):

```
VinceraError (base — carries agent_name and context dict)
├── ConfigError
├── LLMError
│   └── LLMCircuitOpenError
├── DiscoveryError
├── ResearchError
├── VerificationError
├── SandboxError
├── DeploymentError
├── SupabaseError
├── GhostModeError
├── AuthorityError
└── ResourceError
```

All exceptions are importable from both `vincera.utils.errors` and `vincera.utils`.

### Circuit Breaker

The LLM client (`vincera/core/llm.py: OpenRouterClient`) implements a circuit breaker pattern:

- **CLOSED** (normal): requests pass through
- **OPEN** (after 5 consecutive failures): all requests immediately raise `LLMCircuitOpenError`. Cooldown: 300 seconds.
- **HALF_OPEN** (after cooldown expires): one test request is allowed. If it succeeds, circuit closes. If it fails, circuit re-opens.

State transitions are logged at INFO level. The circuit breaker does not prevent fallback — `_call_with_fallback()` tries: requested model → default model → `anthropic/claude-haiku-4-5` (last resort).

### Resource Monitoring

`ResourceMonitor` (see `vincera/utils/resources.py`) checks disk and memory usage periodically (every 30 seconds in the main loop):

| Resource | Threshold | Action |
|----------|-----------|--------|
| Disk | 90% | Warning logged + event sent |
| Disk | 95% | System paused, alert sent |
| Memory | 80% | Warning logged + event sent |
| Memory | 90% | Kill lowest-priority agent (stub — logs warning only) |

### Secret Redaction

`SecretRedactionFilter` (see `vincera/utils/logging.py`) is a `logging.Filter` attached to all log handlers. It redacts:

- OpenRouter API keys (`sk-or-...`) → `***REDACTED_API_KEY***`
- JWT tokens (`eyJ...`) → `***REDACTED_TOKEN***`
- Known secret field names (api_key, service_key, password, token, authorization) → `field=***`
- Connection string passwords (`postgres://user:password@host`) → `postgres://user:***@host`
- Supabase URL apikey params → `apikey=***`

The filter never drops records — it modifies the message in-place and always returns True.

## Ghost Mode

Ghost Mode is controlled by `GhostModeController` (see `vincera/core/ghost_mode.py`). During this period (default: 7 days, configurable via `ghost_mode_days` in config):

1. The agent observes all company operations
2. No automations are deployed or executed
3. Daily reports are generated in `ghost_reports` with:
   - `observed_processes` — what the agent saw
   - `would_have_automated` — what it would have done
   - `estimated_hours_saved` — projected savings
   - `estimated_tasks_automated` — projected task count
   - `key_observations` — notable findings

The dashboard's Ghost Mode page shows a progress bar (days elapsed / total), daily report cards, and an option to transition to active mode early.

When ghost mode ends (either by timer or user action), the Orchestrator transitions to the `active` phase and begins dispatching agents.

## Configuration

`VinceraSettings` (see `vincera/config.py`) uses Pydantic Settings:

| Setting | Default | Notes |
|---------|---------|-------|
| `openrouter_api_key` | required | Encrypted with Fernet at rest |
| `company_name` | required | |
| `agent_name` | "vincera" | |
| `company_id` | None | Set after Supabase registration |
| `supabase_url` | required | |
| `supabase_anon_key` | required | |
| `supabase_service_key` | required | Encrypted with Fernet at rest |
| `home_dir` | ~/VinceraHQ | |
| `orchestrator_model` | anthropic/claude-opus-4-5 | |
| `agent_model` | anthropic/claude-sonnet-4-5 | |
| `ghost_mode_days` | 7 | |

Home directory structure: `core/`, `agents/`, `scripts/`, `knowledge/`, `inbox/`, `outbox/`, `logs/`, `deployments/`, `training/`.

## LLM Client

`OpenRouterClient` (see `vincera/core/llm.py`) provides:

- `think()` — standard chat completion
- `think_structured()` — JSON output via tool calling with fallback to JSON prompting
- `think_with_tools()` — multi-turn tool-calling loop (up to 10 iterations)
- `research()` — tries `perplexity/sonar-pro` first, falls back to standard completion

All methods use the fallback chain: requested model → default model → `anthropic/claude-haiku-4-5`.

Token usage is logged to local SQLite with per-model cost estimates.
