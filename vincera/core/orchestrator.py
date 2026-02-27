"""Orchestrator — the always-on central brain of Vincera.

LOOK → THINK → ACT → NARRATE — every cycle, non-stop.

The orchestrator has direct access to the machine.  It runs commands,
reads logs, watches processes, inspects databases, monitors file changes
— constantly.  It doesn't delegate observation.  It IS the observer.

When it finds something that needs deeper work — automation, research,
repair, analysis — it spins up the right sub-agent, gives it a task,
watches it work, and kills it when done.

It narrates everything in real-time chat.
"""

from __future__ import annotations

import json
import logging
import re
import traceback
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from pydantic import BaseModel

from vincera.core.priority import AutomationCandidate, ScoredCandidate

if TYPE_CHECKING:
    from vincera.agents.base import BaseAgent
    from vincera.config import VinceraSettings
    from vincera.core.authority import AuthorityManager
    from vincera.core.ghost_mode import GhostModeController
    from vincera.core.llm import OpenRouterClient
    from vincera.core.ontology import BusinessOntology, OntologyMapping
    from vincera.core.priority import PriorityEngine
    from vincera.core.state import GlobalState
    from vincera.core.system_observer import SystemDiff, SystemObserver, SystemSnapshot
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.verification.verifier import Verifier

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Brain state
# ---------------------------------------------------------------------------

class OrchestratorState(BaseModel):
    """Serializable brain state — survives restarts."""

    current_phase: str = "installing"
    active_subphase: str = "working"  # working | post_completion | seeking | observing
    company_model: dict | None = None
    ontology_mapping: dict | None = None
    ranked_automations: list[dict] = []
    active_tasks: list[dict] = []
    completed_tasks: list[dict] = []
    failed_tasks: list[dict] = []
    pending_operations: list[dict] = []   # follow-up tasks for operator/analyst/etc.
    cycle_count: int = 0
    last_discovery_at: str | None = None
    last_training_at: str | None = None
    last_analysis_at: str | None = None
    last_opportunity_scan_at: str | None = None
    # LTAN observation state
    last_snapshot: dict | None = None
    last_diff_summary: dict | None = None
    last_observation_at: str | None = None
    active_agent_sessions: list[dict] = []  # [{agent_name, task_name, started_at}]


# ---------------------------------------------------------------------------
# Read-only command allow-list (for LLM-requested shell commands)
# ---------------------------------------------------------------------------

_ALLOWED_COMMANDS = frozenset({
    "ls", "cat", "tail", "head", "ps", "df", "du", "top", "uptime",
    "netstat", "ss", "lsof", "uname", "hostname", "whoami", "id",
    "crontab", "launchctl", "systemctl", "wc", "file", "stat",
    "find", "grep", "which", "env", "printenv", "mount", "free",
    "docker", "pip", "npm", "node", "python3",
})

_DANGEROUS_CHARS = re.compile(r"[;|&><`$()]")


def _is_safe_command(args: list[str]) -> bool:
    """Return True only for read-only commands without shell injection."""
    if not args:
        return False
    cmd = args[0].split("/")[-1]  # handle /usr/bin/ls → ls
    if cmd not in _ALLOWED_COMMANDS:
        return False
    joined = " ".join(args)
    if _DANGEROUS_CHARS.search(joined):
        return False
    return True


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class Orchestrator:
    """Central brain — LOOK → THINK → ACT → NARRATE, every cycle, non-stop.

    The orchestrator is the ONLY thing that activates agents.  Agents are
    spun up for specific tasks, then killed when done.  Every activation
    and deactivation is announced in chat.
    """

    # Intervals for continuous-improvement housekeeping
    REDISCOVERY_INTERVAL_SECONDS = 7200        # 2 h
    TRAINING_INTERVAL_SECONDS = 14400          # 4 h
    ANALYSIS_INTERVAL_SECONDS = 3600           # 1 h
    OPPORTUNITY_SCAN_INTERVAL_SECONDS = 1800   # 30 min

    def __init__(
        self,
        config: VinceraSettings,
        llm: OpenRouterClient,
        supabase: SupabaseManager,
        state: GlobalState,
        ontology: BusinessOntology,
        priority_engine: PriorityEngine,
        authority: AuthorityManager,
        ghost_controller: GhostModeController,
        verifier: Verifier,
        agents: dict[str, BaseAgent],
        observer: SystemObserver | None = None,
    ) -> None:
        self._config = config
        self._llm = llm
        self._sb = supabase
        self._state = state
        self._ontology = ontology
        self._priority = priority_engine
        self._authority = authority
        self._ghost = ghost_controller
        self._verifier = verifier
        self._agents = agents
        self._observer = observer
        self._brain = OrchestratorState(current_phase="installing")
        self._company_id = config.company_id

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        """Load brain state from Supabase if it exists, otherwise start fresh."""
        self._ghost.load_state(self._company_id)

        saved = self._sb.get_latest_brain_state(self._company_id)
        if saved:
            self._brain = OrchestratorState(**saved)

            # Restore observer snapshot from brain for diff continuity
            if self._observer and self._brain.last_snapshot:
                from vincera.core.system_observer import SystemSnapshot
                try:
                    self._observer.last_snapshot = SystemSnapshot(**self._brain.last_snapshot)
                except Exception:
                    pass

            await self._narrate(
                f"Vincera restarted.  Resuming from phase **{self._brain.current_phase}** "
                f"(cycle {self._brain.cycle_count}).  "
                f"Backlog: {len(self._brain.ranked_automations)} | "
                f"Completed: {len(self._brain.completed_tasks)} | "
                f"Pending ops: {len(self._brain.pending_operations)}.  "
                f"Getting back to work."
            )
        else:
            self._brain = OrchestratorState(current_phase="installing")

    async def run_cycle(self) -> dict:
        """One decision cycle.  Called repeatedly by the Scheduler."""
        self._brain.cycle_count += 1

        if self._state.is_paused():
            return {"action": "paused", "reason": "Agent is paused by user"}

        phase = self._brain.current_phase
        handler = {
            "installing": self._phase_install,
            "discovering": self._phase_discover,
            "researching": self._phase_research,
            "ghost": self._phase_ghost,
            "active": self._phase_active,
        }.get(phase)

        if handler:
            return await handler()
        return {"action": "error", "reason": f"Unknown phase: {phase}"}

    # ------------------------------------------------------------------
    # Phases (installing → discovering → researching → ghost → active)
    # ------------------------------------------------------------------

    async def _phase_install(self) -> dict:
        self._brain.current_phase = "discovering"
        await self._save_brain()
        return {"action": "phase_transition", "from": "installing", "to": "discovering"}

    async def _phase_discover(self) -> dict:
        if "discovery" not in self._agents:
            return {"action": "error", "reason": "Discovery agent not registered"}

        agent = self._agents["discovery"]
        if agent.status.value == "idle":
            await self._narrate(
                "Starting initial discovery.  I'm scanning your system — "
                "software, files, databases, processes — to understand how "
                "your business operates.  Let me take a look..."
            )
            await agent.execute({"mode": "initial"})

        self._brain.current_phase = "researching"
        self._brain.last_discovery_at = datetime.now(timezone.utc).isoformat()
        await self._save_brain()
        return {"action": "phase_transition", "from": "discovering", "to": "researching"}

    async def _phase_research(self) -> dict:
        if "research" not in self._agents:
            self._brain.current_phase = "ghost"
            await self._save_brain()
            return {
                "action": "phase_transition",
                "from": "researching",
                "to": "ghost",
                "note": "research agent unavailable, skipped",
            }

        agent = self._agents["research"]
        if agent.status.value == "idle":
            company_model = self._load_company_model()
            if company_model:
                await self._narrate(
                    f"Discovery complete.  Now researching best practices for "
                    f"**{company_model.business_type}** businesses in "
                    f"**{company_model.industry}**.  "
                    f"Looking for industry-proven automation patterns..."
                )
                await agent.execute({"company_model": company_model})
                mapping = self._ontology.map_company(company_model)
                self._brain.ontology_mapping = mapping.model_dump()
                self._brain.company_model = company_model.model_dump()

        self._brain.current_phase = "ghost"
        await self._save_brain()
        return {"action": "phase_transition", "from": "researching", "to": "ghost"}

    async def _phase_ghost(self) -> dict:
        # Skip ghost mode entirely if configured with 0 days
        if self._config.ghost_mode_days <= 0:
            self._brain.current_phase = "active"
            self._brain.active_subphase = "observing"
            await self._build_initial_backlog()
            await self._save_brain()
            return {
                "action": "phase_transition",
                "from": "ghost",
                "to": "active",
                "note": "ghost mode disabled (0 days)",
            }

        if not self._ghost.is_active:
            if self._ghost.start_date is None:
                await self._ghost.start(self._company_id, self._config.ghost_mode_days)
                return {"action": "ghost_started", "days": self._config.ghost_mode_days}

            if await self._ghost.should_end(self._company_id):
                await self._ghost.end(self._company_id)
                self._brain.current_phase = "active"
                self._brain.active_subphase = "observing"
                await self._build_initial_backlog()
                await self._save_brain()
                return {"action": "phase_transition", "from": "ghost", "to": "active"}

        return {"action": "observing", "days_remaining": self._ghost.days_remaining}

    # ==================================================================
    # ACTIVE PHASE — LOOK → THINK → ACT → NARRATE (non-stop)
    # ==================================================================

    async def _phase_active(self) -> dict:
        """The LTAN loop.  Runs every cycle.  Never stops.

        LOOK:    Take a system snapshot, compute diff.
        THINK:   LLM analyzes what changed.
        ACT:     Spin up agents, alert user, process backlog.
        NARRATE: Post everything to chat.
        """
        if not self._authority.can_act():
            return {"action": "blocked", "reason": "Authority level does not permit action"}

        return await self._observe_and_act()

    # ------------------------------------------------------------------
    # LOOK → THINK → ACT → NARRATE
    # ------------------------------------------------------------------

    async def _observe_and_act(self) -> dict:
        """The complete LTAN cycle."""
        self._brain.active_subphase = "observing"

        # ============================================================
        # LOOK — take a system snapshot and compute diff
        # ============================================================
        snapshot = None
        diff = None
        if self._observer:
            try:
                snapshot = await self._observer.take_snapshot()
                diff = self._observer.diff(self._observer.last_snapshot, snapshot)
                self._observer.last_snapshot = snapshot
                self._brain.last_snapshot = snapshot.model_dump()
                self._brain.last_diff_summary = {
                    "total_changes": diff.total_changes,
                    "severity": diff.severity,
                    "new_processes": len(diff.new_processes),
                    "stopped_processes": len(diff.stopped_processes),
                    "modified_files": len(diff.modified_files),
                    "log_anomalies": len(diff.log_anomalies),
                }
                self._brain.last_observation_at = datetime.now(timezone.utc).isoformat()
            except Exception as exc:
                logger.exception("System observation failed")
                await self._narrate(f"System scan encountered an error: {str(exc)[:200]}")

        # ============================================================
        # THINK — LLM analyzes what it sees (only when changes detected)
        # ============================================================
        analysis: dict = {
            "summary": "No changes detected.",
            "concerns": [],
            "opportunities": [],
            "recommended_actions": [],
        }

        if snapshot and diff:
            should_analyze = (
                diff.total_changes > 0
                or self._brain.cycle_count % 5 == 0  # every 5th cycle regardless
            )
            if should_analyze:
                analysis = await self._analyze_observations(snapshot, diff)

        # ============================================================
        # ACT — dispatch agents, flag issues, process backlog
        # ============================================================
        observation_actions: list[dict] = []
        observation_results: list[dict] = []

        if diff:
            observation_actions = await self._decide_actions(analysis, diff)
            for action in observation_actions:
                result = await self._execute_observation_action(action)
                observation_results.append(result)

        # Also run backlog / continuous improvement
        backlog_result = await self._process_backlog_if_needed()

        # ============================================================
        # NARRATE — post everything to chat
        # ============================================================
        if snapshot and diff:
            await self._narrate_cycle(
                snapshot, diff, analysis, observation_actions, observation_results,
            )

        await self._save_brain()

        # If backlog produced a meaningful result (task_completed, task_failed,
        # operation_completed, etc.), propagate it as the cycle result so callers
        # see the primary action taken.
        if (
            backlog_result
            and isinstance(backlog_result, dict)
            and backlog_result.get("action") not in (None, "monitoring", "idle")
        ):
            backlog_result["observation"] = {
                "cycle": self._brain.cycle_count,
                "diff_severity": diff.severity if diff else "unknown",
                "total_changes": diff.total_changes if diff else 0,
                "actions_taken": len(observation_results),
            }
            return backlog_result

        return {
            "action": "observation_cycle",
            "cycle": self._brain.cycle_count,
            "diff_severity": diff.severity if diff else "unknown",
            "total_changes": diff.total_changes if diff else 0,
            "actions_taken": len(observation_results),
            "backlog_result": backlog_result,
        }

    # ------------------------------------------------------------------
    # THINK — LLM analysis of observations
    # ------------------------------------------------------------------

    async def _analyze_observations(
        self,
        snapshot: SystemSnapshot,
        diff: SystemDiff,
    ) -> dict:
        """LLM analyzes the snapshot and diff.

        Returns: {summary, concerns, opportunities, recommended_actions}.
        """
        context = self._build_observation_context(snapshot, diff)

        try:
            analysis = await self._llm.think_structured(
                system_prompt=(
                    f"You are the Vincera orchestrator, an always-on AI system observer "
                    f"running for {self._config.company_name}.  You have root access to the "
                    f"machine.  You just scanned the system.  Analyze what you see and what "
                    f"changed.  Identify concerns, automation opportunities, and actions.\n\n"
                    f"Available agents: discovery, research, builder, operator, analyst, "
                    f"unstuck, trainer.  Only recommend spinning up an agent if there is "
                    f"genuine work for it.  Be specific.  Return valid JSON."
                ),
                user_message=context,
                response_schema={
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string"},
                        "concerns": {"type": "array", "items": {"type": "string"}},
                        "opportunities": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "description": {"type": "string"},
                                    "domain": {"type": "string"},
                                    "estimated_hours_saved_weekly": {"type": "number"},
                                },
                            },
                        },
                        "recommended_actions": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string"},
                                    "agent": {"type": "string"},
                                    "task": {"type": "string"},
                                    "priority": {"type": "string"},
                                    "reason": {"type": "string"},
                                },
                            },
                        },
                    },
                },
            )
            if isinstance(analysis, dict):
                return analysis
            return {
                "summary": "Analysis returned unexpected format.",
                "concerns": [],
                "opportunities": [],
                "recommended_actions": [],
            }
        except Exception as exc:
            logger.exception("Observation analysis failed")
            return {
                "summary": f"Analysis failed: {str(exc)[:200]}",
                "concerns": [],
                "opportunities": [],
                "recommended_actions": [],
            }

    # ------------------------------------------------------------------
    # ACT — decide what to do
    # ------------------------------------------------------------------

    async def _decide_actions(
        self,
        analysis: dict,
        diff: SystemDiff,
    ) -> list[dict]:
        """Convert LLM analysis into concrete actions."""
        actions: list[dict] = []

        # 1. Auto-alert on high severity
        if diff.severity == "alert":
            alert_parts = []
            if diff.log_anomalies:
                alert_parts.append(f"{len(diff.log_anomalies)} log anomalies")
            if diff.disk_usage_changes:
                alert_parts.append(f"{len(diff.disk_usage_changes)} disk changes")
            if diff.new_processes:
                alert_parts.append(f"{len(diff.new_processes)} new processes")
            actions.append({
                "type": "alert_user",
                "message": f"ALERT: {', '.join(alert_parts)}",
            })

        # 2. LLM-recommended actions
        for rec in analysis.get("recommended_actions", []):
            action_type = rec.get("type", "flag")

            if action_type == "spin_up_agent":
                agent_name = rec.get("agent", "")
                if agent_name in self._agents:
                    actions.append({
                        "type": "spin_up_agent",
                        "agent": agent_name,
                        "task": rec.get("task", {}),
                        "reason": rec.get("reason", ""),
                    })
            elif action_type == "alert_user":
                actions.append({
                    "type": "alert_user",
                    "message": rec.get("reason", ""),
                })
            elif action_type == "run_command":
                actions.append({
                    "type": "run_command",
                    "command": rec.get("task", ""),
                })

        # 3. New opportunities → add to backlog
        for opp in analysis.get("opportunities", []):
            if opp.get("name"):
                actions.append({"type": "add_opportunity", "opportunity": opp})

        return actions

    # ------------------------------------------------------------------
    # ACT — execute a single action
    # ------------------------------------------------------------------

    async def _execute_observation_action(self, action: dict) -> dict:
        """Execute one action from the ACT phase."""
        action_type = action.get("type", "")

        if action_type == "spin_up_agent":
            return await self._spin_up_agent(action)

        elif action_type == "alert_user":
            await self._narrate(f"**ALERT:** {action.get('message', '')}")
            return {"action": "alerted"}

        elif action_type == "run_command":
            return await self._run_observation_command(action)

        elif action_type == "add_opportunity":
            opp = action.get("opportunity", {})
            await self._add_external_opportunities([opp], "live_observation")
            return {"action": "opportunity_added", "name": opp.get("name", "")}

        return {"action": "unknown", "type": action_type}

    async def _spin_up_agent(self, action: dict) -> dict:
        """Spin up a sub-agent for a specific task.  Announce, execute, kill."""
        agent_name = action.get("agent", "")
        task = action.get("task", {})
        reason = action.get("reason", "")

        if agent_name not in self._agents:
            return {"action": "agent_unavailable", "agent": agent_name}

        # If task is a string, wrap it
        if isinstance(task, str):
            task = {"type": task, "description": task}

        # ANNOUNCE activation
        await self._narrate(
            f"Spinning up **{agent_name}** agent.\n"
            f"Reason: {reason}\n"
            f"Task: {task.get('type', task.get('description', str(task)[:100]))}"
        )

        # Track active session
        session = {
            "agent_name": agent_name,
            "task_name": task.get("type", task.get("name", str(task)[:50])),
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        self._brain.active_agent_sessions.append(session)
        await self._save_brain()

        try:
            result = await self._agents[agent_name].execute(task)

            # ANNOUNCE deactivation
            status = result.get("status", "done") if isinstance(result, dict) else "done"
            await self._narrate(
                f"Agent **{agent_name}** completed.  Status: {status}"
            )

            # Remove session
            self._brain.active_agent_sessions = [
                s for s in self._brain.active_agent_sessions
                if s["agent_name"] != agent_name
            ]
            return {"action": "agent_completed", "agent": agent_name, "result": result}

        except Exception as exc:
            error_str = str(exc)[:300]
            await self._narrate(
                f"Agent **{agent_name}** FAILED: {error_str}"
            )
            self._brain.active_agent_sessions = [
                s for s in self._brain.active_agent_sessions
                if s["agent_name"] != agent_name
            ]
            return {"action": "agent_failed", "agent": agent_name, "error": error_str}

    async def _run_observation_command(self, action: dict) -> dict:
        """Execute a read-only shell command for deeper inspection."""
        cmd = action.get("command", "")
        if isinstance(cmd, str):
            cmd_args = cmd.split()
        else:
            cmd_args = list(cmd)

        if not _is_safe_command(cmd_args):
            await self._narrate(
                f"Blocked unsafe command: `{' '.join(cmd_args[:5])}`"
            )
            return {"action": "command_blocked", "command": cmd_args}

        if not self._observer:
            return {"action": "no_observer"}

        result = await self._observer.run_shell_command(cmd_args, timeout=15)
        return {"action": "command_run", "result": result}

    # ------------------------------------------------------------------
    # NARRATE — cycle report
    # ------------------------------------------------------------------

    async def _narrate_cycle(
        self,
        snapshot: SystemSnapshot,
        diff: SystemDiff,
        analysis: dict,
        actions: list[dict],
        results: list[dict],
    ) -> None:
        """Post a cycle observation report to chat.  Always."""
        parts = [f"**Cycle {self._brain.cycle_count} — system observation:**"]

        # What I see
        parts.append(
            f"CPU: {snapshot.cpu_percent:.1f}% | "
            f"Memory: {snapshot.memory_used_percent:.1f}% | "
            f"Processes: {snapshot.process_count} | "
            f"Databases: {len(snapshot.databases)} | "
            f"Scan: {snapshot.scan_duration_ms}ms"
        )

        # What changed
        if diff.total_changes > 0:
            changes: list[str] = []
            if diff.new_processes:
                names = ", ".join(p.get("name", "?") for p in diff.new_processes[:3])
                changes.append(f"{len(diff.new_processes)} new processes ({names})")
            if diff.stopped_processes:
                names = ", ".join(p.get("name", "?") for p in diff.stopped_processes[:3])
                changes.append(f"{len(diff.stopped_processes)} stopped ({names})")
            if diff.modified_files:
                changes.append(f"{len(diff.modified_files)} modified files")
            if diff.new_files:
                changes.append(f"{len(diff.new_files)} new files")
            if diff.log_anomalies:
                changes.append(f"{len(diff.log_anomalies)} log anomalies")
            if diff.new_databases:
                changes.append(f"{len(diff.new_databases)} new databases")
            if diff.new_scheduled_tasks:
                changes.append(f"{len(diff.new_scheduled_tasks)} new scheduled tasks")
            if abs(diff.cpu_change) > 10:
                changes.append(f"CPU {'up' if diff.cpu_change > 0 else 'down'} {abs(diff.cpu_change):.1f}%")
            if abs(diff.memory_change) > 5:
                changes.append(f"Memory {'up' if diff.memory_change > 0 else 'down'} {abs(diff.memory_change):.1f}%")
            parts.append(f"Changes: {'; '.join(changes)}")
        else:
            parts.append("No changes since last scan.  System stable.")

        # What I think
        summary = analysis.get("summary", "")
        if summary and summary != "No changes detected.":
            parts.append(f"Assessment: {summary[:300]}")

        # Concerns
        concerns = analysis.get("concerns", [])
        if concerns:
            parts.append("Concerns: " + "; ".join(c[:100] for c in concerns[:3]))

        # What I did
        if actions:
            action_summary = []
            for a in actions[:5]:
                atype = a.get("type", "?")
                if atype == "spin_up_agent":
                    action_summary.append(f"activated {a.get('agent', '?')}")
                elif atype == "alert_user":
                    action_summary.append("sent alert")
                elif atype == "run_command":
                    action_summary.append(f"ran command")
                elif atype == "add_opportunity":
                    action_summary.append(f"found opportunity: {a.get('opportunity', {}).get('name', '?')}")
            parts.append(f"Actions: {', '.join(action_summary)}")

        # Backlog status
        backlog_count = len(self._brain.ranked_automations)
        completed_count = len(self._brain.completed_tasks)
        if backlog_count > 0 or completed_count > 0:
            parts.append(
                f"Backlog: {backlog_count} | Completed: {completed_count} | "
                f"Failed: {len(self._brain.failed_tasks)}"
            )

        await self._narrate("\n".join(parts))

    # ------------------------------------------------------------------
    # ACT (backlog) — process pending operations and backlog items
    # ------------------------------------------------------------------

    async def _process_backlog_if_needed(self) -> dict | None:
        """After observing, process any pending work."""

        # --- Priority 1: Pending post-completion operations ---------------
        if self._brain.pending_operations:
            self._brain.active_subphase = "post_completion"
            return await self._dispatch_pending_operation()

        # --- Priority 2: Work through backlog -----------------------------
        if self._brain.ranked_automations:
            # Filter out already-completed / already-failed tasks
            completed_names = {t["name"] for t in self._brain.completed_tasks}
            failed_names = {t["name"] for t in self._brain.failed_tasks}
            self._brain.ranked_automations = [
                r for r in self._brain.ranked_automations
                if r.get("candidate", r).get("name") not in completed_names
                and r.get("candidate", r).get("name") not in failed_names
            ]
            if self._brain.ranked_automations:
                self._brain.active_subphase = "working"
                return await self._work_on_backlog_item()

        # --- Priority 3: Build backlog on first entry --------------------
        if (
            not self._brain.ranked_automations
            and not self._brain.completed_tasks
            and not self._brain.failed_tasks
        ):
            await self._build_initial_backlog()
            if self._brain.ranked_automations:
                self._brain.active_subphase = "working"
                return await self._work_on_backlog_item()
            return {"action": "idle", "reason": "No automations found yet"}

        # --- Priority 4: Continuous improvement ---------------------------
        self._brain.active_subphase = "seeking"
        return await self._continuous_improvement()

    # ------------------------------------------------------------------
    # Active: work on backlog
    # ------------------------------------------------------------------

    async def _work_on_backlog_item(self) -> dict:
        """Pick the highest-priority task and dispatch it."""
        try:
            batch = self._priority.get_next_batch(
                [ScoredCandidate(**s) for s in self._brain.ranked_automations],
                batch_size=1,
            )
        except Exception as exc:
            logger.exception("Failed to parse ranked_automations")
            return {"action": "error", "reason": str(exc)}

        if not batch:
            return {"action": "idle", "reason": "No non-backlog automations remaining"}

        task = batch[0]

        # --- Sensitivity detection & risk classification ------------------
        is_sensitive, sensitivity_reason = self._detect_sensitivity(task.candidate)
        risk = self._authority.classify_risk(
            task.candidate.description,
            affects_financial=task.candidate.affects_financial_data,
            affects_customer=task.candidate.affects_customer_data,
            is_reversible=task.candidate.reversible,
            modifies_system=task.candidate.requires_system_modification,
        )

        if is_sensitive:
            await self._narrate(
                f"**SENSITIVE TASK** — **{task.candidate.name}** involves sensitive data.\n"
                f"Reason: {sensitivity_reason}\n"
                f"Risk level: **{risk.value}**\n"
                f"I need your approval before proceeding."
            )

        # --- Select agent -------------------------------------------------
        agent_name = self._select_agent_for_task(task)
        if not agent_name or agent_name not in self._agents:
            await self._narrate(
                f"I want to work on \"{task.candidate.name}\" but no agent is "
                f"available for domain '{task.candidate.domain}'.  Skipping."
            )
            self._remove_from_backlog(task.candidate.name)
            await self._save_brain()
            return {"action": "no_agent", "task": task.candidate.name}

        # --- Get approval -------------------------------------------------
        approved = await self._authority.request_if_needed(
            self._agents[agent_name],
            task.candidate.name,
            risk,
            context=task.candidate.description,
        )
        if not approved:
            await self._narrate(
                f"You denied \"{task.candidate.name}\".  Moving on."
            )
            self._remove_from_backlog(task.candidate.name)
            await self._save_brain()
            return {"action": "task_denied", "task": task.candidate.name}

        # --- ANNOUNCE agent activation ------------------------------------
        await self._narrate(
            f"Spinning up **{agent_name}** for: **{task.candidate.name}**\n"
            f"Score: {task.final_score:.2f} | Risk: {risk.value}\n"
            f"What this does: {task.candidate.description}\n"
            f"Expected savings: ~{task.candidate.estimated_hours_saved_weekly}h/week"
        )

        # Track as active
        task_record = {
            "name": task.candidate.name,
            "agent": agent_name,
            "status": "in_progress",
            "risk": risk.value,
            "description": task.candidate.description,
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        self._brain.active_tasks.append(task_record)
        self._brain.active_agent_sessions.append({
            "agent_name": agent_name,
            "task_name": task.candidate.name,
            "started_at": task_record["started_at"],
        })
        await self._save_brain()

        # --- DISPATCH: Actually run the agent -----------------------------
        agent_task = {
            "name": task.candidate.name,
            "description": task.candidate.description,
            "business_context": (
                f"Company: {self._config.company_name}.  "
                f"Priority: {task.priority}.  "
                f"Estimated hours saved: {task.candidate.estimated_hours_saved_weekly}/week."
            ),
            "constraints": [],
        }

        try:
            result = await self._agents[agent_name].execute(agent_task)

            # ---- SUCCESS ----
            task_record["status"] = "completed"
            task_record["result"] = result
            task_record["completed_at"] = datetime.now(timezone.utc).isoformat()
            self._brain.completed_tasks.append(task_record)
            self._brain.active_tasks = [
                t for t in self._brain.active_tasks
                if t.get("name") != task.candidate.name
            ]
            self._brain.active_agent_sessions = [
                s for s in self._brain.active_agent_sessions
                if s.get("agent_name") != agent_name
            ]
            self._remove_from_backlog(task.candidate.name)

            # Queue follow-up operations
            self._queue_post_completion(task_record, result)

            status = result.get("status", "unknown")
            await self._narrate(
                f"Agent **{agent_name}** completed: **{task.candidate.name}** (status: {status})\n"
                f"Remaining in backlog: {len(self._brain.ranked_automations)}\n"
                f"Setting up monitoring and follow-up checks."
            )
            await self._save_brain()
            return {
                "action": "task_completed",
                "task": task.candidate.name,
                "agent": agent_name,
                "result": result,
            }

        except Exception as exc:
            # ---- FAILURE ----
            logger.exception(
                "Agent %s failed on task %s", agent_name, task.candidate.name,
            )
            error_str = str(exc)[:500]
            task_record["status"] = "failed"
            task_record["error"] = error_str
            task_record["failed_at"] = datetime.now(timezone.utc).isoformat()
            self._brain.failed_tasks.append(task_record)
            self._brain.active_tasks = [
                t for t in self._brain.active_tasks
                if t.get("name") != task.candidate.name
            ]
            self._brain.active_agent_sessions = [
                s for s in self._brain.active_agent_sessions
                if s.get("agent_name") != agent_name
            ]
            self._remove_from_backlog(task.candidate.name)

            # Queue unstuck agent to diagnose
            self._queue_unstuck_diagnosis(task_record, error_str)

            await self._narrate(
                f"Agent **{agent_name}** FAILED on **{task.candidate.name}**\n"
                f"Error: {error_str}\n"
                f"Dispatching unstuck agent to diagnose.  "
                f"Remaining in backlog: {len(self._brain.ranked_automations)}"
            )
            await self._save_brain()
            return {
                "action": "task_failed",
                "task": task.candidate.name,
                "agent": agent_name,
                "error": error_str,
            }

    # ------------------------------------------------------------------
    # Active: dispatch pending operations
    # ------------------------------------------------------------------

    async def _dispatch_pending_operation(self) -> dict:
        """Execute the next pending follow-up operation."""
        if not self._brain.pending_operations:
            return {"action": "no_pending"}

        op = self._brain.pending_operations.pop(0)
        op_type = op.get("type", "")
        agent_name = op.get("agent", "")

        if agent_name not in self._agents:
            await self._narrate(
                f"Wanted to run **{op.get('description', op_type)}** "
                f"via {agent_name}, but that agent isn't available.  Skipping."
            )
            await self._save_brain()
            return {"action": "agent_unavailable", "operation": op_type}

        await self._narrate(
            f"Spinning up **{agent_name}** for follow-up: **{op.get('description', op_type)}**"
        )

        try:
            result = await self._agents[agent_name].execute(op.get("task", {}))
            await self._narrate(
                f"Agent **{agent_name}** completed follow-up: **{op.get('description', op_type)}** — "
                f"status: {result.get('status', 'done')}"
            )
            await self._save_brain()
            return {
                "action": "operation_completed",
                "type": op_type,
                "result": result,
            }
        except Exception as exc:
            logger.exception("Pending operation %s failed", op_type)
            await self._narrate(
                f"Agent **{agent_name}** FAILED on follow-up: {op.get('description', op_type)} — "
                f"{str(exc)[:200]}"
            )
            await self._save_brain()
            return {
                "action": "operation_failed",
                "type": op_type,
                "error": str(exc)[:300],
            }

    # ------------------------------------------------------------------
    # Active: continuous improvement (backlog empty — keep searching)
    # ------------------------------------------------------------------

    async def _continuous_improvement(self) -> dict:
        """When the backlog is empty, keep working:
        -  Run periodic discovery for new opportunities
        -  Run analyst for optimization scans
        -  Run trainer if corrections exist
        -  Use LLM to brainstorm new ideas
        -  Rebuild backlog and keep going
        """
        now = datetime.now(timezone.utc)

        # 1. Periodic re-discovery
        if self._should_run("discovery", self._brain.last_discovery_at,
                            self.REDISCOVERY_INTERVAL_SECONDS):
            return await self._run_periodic_discovery(now)

        # 2. Periodic analysis
        if self._should_run("analyst", self._brain.last_analysis_at,
                            self.ANALYSIS_INTERVAL_SECONDS,
                            requires_data=bool(self._brain.completed_tasks)):
            return await self._run_analysis_scan(now)

        # 3. Periodic training
        if self._should_run("trainer", self._brain.last_training_at,
                            self.TRAINING_INTERVAL_SECONDS,
                            requires_data=bool(
                                self._brain.completed_tasks or self._brain.failed_tasks
                            )):
            return await self._run_training_cycle(now)

        # 4. Opportunity scan (LLM-powered)
        if (
            self._brain.company_model
            and self._should_run(None, self._brain.last_opportunity_scan_at,
                                 self.OPPORTUNITY_SCAN_INTERVAL_SECONDS)
        ):
            return await self._run_opportunity_scan(now)

        # 5. Nothing due right now — report monitoring status
        await self._save_brain()
        return {
            "action": "monitoring",
            "completed": len(self._brain.completed_tasks),
            "failed": len(self._brain.failed_tasks),
            "note": "All tasks processed.  Monitoring for changes and new opportunities.",
        }

    # --- helpers for timing checks ---

    def _should_run(
        self,
        agent_name: str | None,
        last_run_iso: str | None,
        interval_seconds: float,
        *,
        requires_data: bool = True,
    ) -> bool:
        """Return True if enough time has elapsed and the agent is available."""
        if agent_name and agent_name not in self._agents:
            return False
        if not requires_data:
            return False
        if not last_run_iso:
            return True
        try:
            last = datetime.fromisoformat(last_run_iso)
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            return (datetime.now(timezone.utc) - last).total_seconds() > interval_seconds
        except (ValueError, TypeError):
            return True

    # --- periodic sub-tasks ---

    async def _run_periodic_discovery(self, now: datetime) -> dict:
        """Re-scan the system to find new changes and opportunities."""
        await self._narrate(
            "Spinning up **discovery** agent for periodic system scan.  "
            "Looking for new software, files, processes, or configuration changes..."
        )
        try:
            result = await self._agents["discovery"].execute({"mode": "periodic"})
            self._brain.last_discovery_at = now.isoformat()
            await self._rebuild_backlog()

            if self._brain.ranked_automations:
                await self._narrate(
                    f"Discovery agent completed.  Found "
                    f"**{len(self._brain.ranked_automations)} automation "
                    f"opportunities**!  Getting back to work."
                )
            else:
                await self._narrate(
                    "Discovery agent completed.  No new opportunities this cycle."
                )
            await self._save_brain()
            return {
                "action": "discovery_complete",
                "new_tasks": len(self._brain.ranked_automations),
            }
        except Exception as exc:
            logger.exception("Periodic discovery failed")
            self._brain.last_discovery_at = now.isoformat()
            await self._save_brain()
            return {"action": "discovery_failed", "error": str(exc)[:300]}

    async def _run_analysis_scan(self, now: datetime) -> dict:
        """Run analyst to review performance of completed automations."""
        await self._narrate(
            "Spinning up **analyst** agent.  "
            "Checking health metrics, error rates, and efficiency..."
        )
        try:
            deployment_ids = [
                t.get("result", {}).get("deployment_id")
                for t in self._brain.completed_tasks
                if t.get("result", {}).get("deployment_id")
            ]
            if deployment_ids:
                task = {"type": "performance_review", "deployment_ids": deployment_ids}
            else:
                task = {
                    "type": "optimization_scan",
                    "company_model": self._brain.company_model or {},
                }

            result = await self._agents["analyst"].execute(task)
            self._brain.last_analysis_at = now.isoformat()

            # If analyst found new opportunities, add them
            opportunities = result.get("opportunities", [])
            if opportunities:
                await self._add_external_opportunities(opportunities, "analyst")

            await self._narrate(
                f"Analyst agent completed.  Reviewed {len(deployment_ids)} deployments."
            )
            await self._save_brain()
            return {"action": "analysis_complete", "result": result}
        except Exception as exc:
            logger.exception("Analysis scan failed")
            self._brain.last_analysis_at = now.isoformat()
            await self._save_brain()
            return {"action": "analysis_failed", "error": str(exc)[:300]}

    async def _run_training_cycle(self, now: datetime) -> dict:
        """Run trainer to learn from corrections and improve agent behaviour."""
        await self._narrate(
            "Spinning up **trainer** agent.  "
            "Learning from recent corrections..."
        )
        try:
            result = await self._agents["trainer"].execute(
                {"type": "full_training_cycle"},
            )
            self._brain.last_training_at = now.isoformat()
            await self._narrate("Trainer agent completed.")
            await self._save_brain()
            return {"action": "training_complete", "result": result}
        except Exception as exc:
            logger.exception("Training cycle failed")
            self._brain.last_training_at = now.isoformat()
            await self._save_brain()
            return {"action": "training_failed", "error": str(exc)[:300]}

    async def _run_opportunity_scan(self, now: datetime) -> dict:
        """Use LLM to brainstorm new automation opportunities."""
        await self._narrate(
            "Thinking about what else I can automate.  "
            "Analysing everything I've learned so far..."
        )
        try:
            context = self._build_opportunity_context()
            ideas = await self._llm.think_structured(
                system_prompt=(
                    "You are an autonomous AI agent analysing a business for automation "
                    "opportunities.  Based on the context below, suggest 2-5 NEW automation "
                    "ideas that haven't been tried yet.  Focus on high-impact, feasible "
                    "automations.  Return valid JSON."
                ),
                user_message=context,
                response_schema={
                    "type": "object",
                    "properties": {
                        "opportunities": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "description": {"type": "string"},
                                    "domain": {"type": "string"},
                                    "estimated_hours_saved_weekly": {"type": "number"},
                                    "complexity": {"type": "string"},
                                },
                            },
                        },
                    },
                },
            )

            new_opps = (
                ideas.get("opportunities", []) if isinstance(ideas, dict) else []
            )
            self._brain.last_opportunity_scan_at = now.isoformat()

            if new_opps:
                await self._add_external_opportunities(new_opps, "llm_brainstorm")
                lines = [
                    f"I've identified **{len(new_opps)} new potential automations**:"
                ]
                for o in new_opps[:5]:
                    lines.append(
                        f"- **{o.get('name', 'Unknown')}**: "
                        f"{o.get('description', '')[:120]}"
                    )
                lines.append("\nAdding these to my backlog.")
                await self._narrate("\n".join(lines))
            else:
                await self._narrate(
                    "Couldn't identify new opportunities right now.  Monitoring."
                )

            await self._save_brain()
            return {
                "action": "opportunity_scan_complete",
                "new_ideas": len(new_opps),
            }
        except Exception as exc:
            logger.exception("Opportunity scan failed")
            self._brain.last_opportunity_scan_at = now.isoformat()
            await self._save_brain()
            return {"action": "opportunity_scan_failed", "error": str(exc)[:300]}

    # ------------------------------------------------------------------
    # Post-completion task queuing
    # ------------------------------------------------------------------

    def _queue_post_completion(self, task_record: dict, result: dict) -> None:
        """After builder completes, queue operator for canary + analyst for review."""
        name = task_record.get("name", "Unknown")
        deployment_id = result.get("deployment_id")
        script_path = result.get("script_path")

        # Queue operator to run canary deployment
        if deployment_id and "operator" in self._agents:
            self._brain.pending_operations.append({
                "type": "operator_canary",
                "agent": "operator",
                "description": f"Run canary deployment for '{name}'",
                "task": {
                    "type": "run_canary",
                    "deployment_id": deployment_id,
                    "script": self._read_script(script_path),
                    "automation_name": name,
                },
            })

        # Queue analyst review after every 2+ completions
        completed_count = len(self._brain.completed_tasks)
        if completed_count >= 2 and "analyst" in self._agents:
            dep_ids = [
                t.get("result", {}).get("deployment_id")
                for t in self._brain.completed_tasks
                if t.get("result", {}).get("deployment_id")
            ]
            if dep_ids:
                self._brain.pending_operations.append({
                    "type": "analyst_review",
                    "agent": "analyst",
                    "description": (
                        f"Performance review of {len(dep_ids)} deployments"
                    ),
                    "task": {
                        "type": "performance_review",
                        "deployment_ids": dep_ids,
                    },
                })

    def _queue_unstuck_diagnosis(self, task_record: dict, error_str: str) -> None:
        """After a task fails, queue the unstuck agent to diagnose."""
        if "unstuck" not in self._agents:
            return
        self._brain.pending_operations.append({
            "type": "unstuck_diagnosis",
            "agent": "unstuck",
            "description": (
                f"Diagnose failure of '{task_record.get('name', 'Unknown')}'"
            ),
            "task": {
                "type": "diagnose",
                "error": error_str,
                "context": task_record.get("description", ""),
            },
        })

    @staticmethod
    def _read_script(script_path: str | None) -> str:
        """Read a script file.  Returns empty string on failure."""
        if not script_path:
            return ""
        try:
            from pathlib import Path

            p = Path(script_path)
            if p.exists():
                return p.read_text()
        except Exception:
            pass
        return ""

    # ------------------------------------------------------------------
    # Sensitivity detection
    # ------------------------------------------------------------------

    @staticmethod
    def _detect_sensitivity(
        candidate: AutomationCandidate,
    ) -> tuple[bool, str]:
        """Check if a task involves sensitive data requiring human approval."""
        reasons: list[str] = []
        if candidate.affects_financial_data:
            reasons.append("touches financial data")
        if candidate.affects_customer_data:
            reasons.append("touches customer data")
        if candidate.requires_system_modification and not candidate.reversible:
            reasons.append("irreversible system modification")
        if not candidate.reversible:
            reasons.append("action is not easily reversible")
        return bool(reasons), "; ".join(reasons)

    # ------------------------------------------------------------------
    # Agent selection — routes to ALL available agents
    # ------------------------------------------------------------------

    _DOMAIN_AGENTS: dict[str, str] = {
        "finance": "builder",
        "sales": "builder",
        "operations": "builder",
        "hr": "builder",
        "inventory": "builder",
        "customer_service": "builder",
        "marketing": "builder",
        "compliance": "builder",
        "it": "builder",
        "procurement": "builder",
        "general": "builder",
    }

    def _select_agent(self, task: ScoredCandidate) -> str | None:
        """Legacy method for backward compatibility."""
        return self._DOMAIN_AGENTS.get(task.candidate.domain)

    def _select_agent_for_task(self, task: ScoredCandidate) -> str | None:
        """Select the best agent for a backlog task."""
        return self._DOMAIN_AGENTS.get(task.candidate.domain, "builder")

    def _select_agent_for_domain(self, domain: str) -> str:
        return self._DOMAIN_AGENTS.get(domain, "builder")

    # ------------------------------------------------------------------
    # Backlog management
    # ------------------------------------------------------------------

    def _remove_from_backlog(self, task_name: str) -> None:
        """Remove a task from ranked_automations by name."""
        self._brain.ranked_automations = [
            r for r in self._brain.ranked_automations
            if r.get("candidate", r).get("name") != task_name
        ]

    async def _build_initial_backlog(self) -> None:
        from vincera.core.ontology import OntologyMapping
        from vincera.discovery.company_model import CompanyModel

        ontology_suggestions: list[dict] = []
        research_insights: list[dict] = []
        discovery_opportunities: list[dict] = []

        if self._brain.ontology_mapping:
            mapping = OntologyMapping(**self._brain.ontology_mapping)
            ontology_suggestions = self._ontology.suggest_automations(mapping)

        if self._brain.company_model:
            model = CompanyModel(**self._brain.company_model)
            discovery_opportunities = [
                {"name": opp, "description": opp} if isinstance(opp, str) else opp
                for opp in (model.automation_opportunities or [])
            ]

        candidates = self._priority.merge_candidates(
            ontology_suggestions, research_insights, discovery_opportunities,
        )
        ranked = self._priority.rank(candidates)
        self._brain.ranked_automations = [s.model_dump() for s in ranked]

        if ranked:
            lines = [
                f"I've identified **{len(ranked)} automation opportunities**.  "
                f"Here's my plan:\n"
            ]
            for i, s in enumerate(ranked, 1):
                sensitive, sense_reason = self._detect_sensitivity(s.candidate)
                flag = "  [SENSITIVE — will need approval]" if sensitive else ""
                lines.append(
                    f"{i}. **{s.candidate.name}** — score {s.final_score:.2f}, "
                    f"priority: {s.priority}{flag}\n   {s.candidate.description}"
                )
            lines.append(
                "\nI'll start working through these now, highest priority first."
            )
            await self._narrate("\n".join(lines))
        else:
            await self._narrate(
                "I analysed your system but couldn't find concrete automation "
                "opportunities yet.  Tell me about repetitive tasks you'd like "
                "me to automate."
            )

    async def _rebuild_backlog(self) -> None:
        """Rebuild backlog from current state, preserving completed/failed."""
        completed_names = {t["name"] for t in self._brain.completed_tasks}
        failed_names = {t["name"] for t in self._brain.failed_tasks}

        await self._build_initial_backlog()

        self._brain.ranked_automations = [
            r for r in self._brain.ranked_automations
            if r.get("candidate", r).get("name") not in completed_names
            and r.get("candidate", r).get("name") not in failed_names
        ]

    async def _add_external_opportunities(
        self,
        opportunities: list[dict],
        source: str,
    ) -> None:
        """Add opportunities from analyst / LLM to the backlog, de-duping."""
        existing = {
            r.get("candidate", r).get("name", "").lower()
            for r in self._brain.ranked_automations
        }
        done = {t["name"].lower() for t in self._brain.completed_tasks}
        fail = {t["name"].lower() for t in self._brain.failed_tasks}
        skip = existing | done | fail

        for opp in opportunities:
            name = opp.get("name", "")
            if not name or name.lower() in skip:
                continue
            candidate = AutomationCandidate(
                name=name,
                domain=opp.get("domain", "general"),
                description=opp.get("description", ""),
                source="discovery",
                evidence=f"{source} scan",
                estimated_hours_saved_weekly=float(
                    opp.get("estimated_hours_saved_weekly",
                            opp.get("estimated_hours_saved", 1)),
                ),
                estimated_complexity=opp.get("complexity", "medium"),
            )
            scored = self._priority.score(candidate)
            self._brain.ranked_automations.append(scored.model_dump())

    def _build_opportunity_context(self) -> str:
        """Build context string for LLM opportunity brainstorming."""
        parts: list[str] = []
        if self._brain.company_model:
            cm = self._brain.company_model
            parts.append(f"Business type: {cm.get('business_type', 'unknown')}")
            parts.append(f"Industry: {cm.get('industry', 'unknown')}")
            stack = cm.get("software_stack", [])
            if stack:
                parts.append(
                    "Software stack: "
                    + ", ".join(
                        s.get("name", "") if isinstance(s, dict) else str(s)
                        for s in stack[:10]
                    )
                )
            procs = cm.get("detected_processes", [])
            if procs:
                parts.append(
                    "Detected processes: "
                    + ", ".join(
                        p.get("name", "") if isinstance(p, dict) else str(p)
                        for p in procs[:10]
                    )
                )

        if self._brain.completed_tasks:
            parts.append(
                f"\nAlready automated ({len(self._brain.completed_tasks)}):"
            )
            for t in self._brain.completed_tasks:
                parts.append(f"  - {t['name']}: {t.get('description', '')[:100]}")

        if self._brain.failed_tasks:
            parts.append(f"\nFailed attempts ({len(self._brain.failed_tasks)}):")
            for t in self._brain.failed_tasks:
                parts.append(f"  - {t['name']}: {t.get('error', '')[:100]}")

        return "\n".join(parts) if parts else "No company model available."

    def _load_company_model(self):
        from vincera.discovery.company_model import CompanyModel

        if self._brain.company_model:
            return CompanyModel(**self._brain.company_model)

        model_path = self._config.home_dir / "knowledge" / "company_model.json"
        if model_path.exists():
            data = json.loads(model_path.read_text())
            return CompanyModel(**data)
        return None

    # ------------------------------------------------------------------
    # Observation context builder
    # ------------------------------------------------------------------

    def _build_observation_context(
        self,
        snapshot: SystemSnapshot,
        diff: SystemDiff,
    ) -> str:
        """Build a concise text summary of snapshot + diff for LLM."""
        parts: list[str] = []
        parts.append(f"Timestamp: {snapshot.timestamp}")
        parts.append(
            f"CPU: {snapshot.cpu_percent:.1f}%, "
            f"Memory: {snapshot.memory_used_percent:.1f}%, "
            f"Available RAM: {snapshot.memory_available_gb:.1f} GB"
        )
        parts.append(f"Processes running: {snapshot.process_count}")

        # Top CPU processes
        top_cpu = sorted(
            snapshot.processes,
            key=lambda p: p.get("cpu_percent", 0) or 0,
            reverse=True,
        )[:5]
        if top_cpu:
            parts.append(
                "Top CPU: "
                + ", ".join(
                    f"{p.get('name', '?')}({p.get('cpu_percent', 0):.1f}%)"
                    for p in top_cpu
                )
            )

        # Disk
        for d in snapshot.disk_usage:
            parts.append(
                f"Disk {d['mountpoint']}: "
                f"{d.get('used_gb', 0):.1f}/{d.get('total_gb', 0):.1f} GB "
                f"({d.get('percent', 0):.0f}%)"
            )

        # Databases
        if snapshot.databases:
            parts.append(
                f"Databases: "
                + ", ".join(d.get("name", "?") for d in snapshot.databases[:5])
            )

        # Scheduled tasks summary
        if snapshot.scheduled_tasks:
            parts.append(f"Scheduled tasks: {len(snapshot.scheduled_tasks)}")

        # --- CHANGES ---
        parts.append("\n--- CHANGES SINCE LAST SCAN ---")
        if diff.new_processes:
            parts.append(
                f"New processes: "
                + ", ".join(p.get("name", "?") for p in diff.new_processes[:10])
            )
        if diff.stopped_processes:
            parts.append(
                f"Stopped: "
                + ", ".join(p.get("name", "?") for p in diff.stopped_processes[:10])
            )
        if diff.modified_files:
            parts.append(
                f"Modified files: "
                + ", ".join(f.get("name", "?") for f in diff.modified_files[:10])
            )
        if diff.new_files:
            parts.append(
                f"New files: "
                + ", ".join(f.get("name", "?") for f in diff.new_files[:10])
            )
        if diff.log_anomalies:
            parts.append(f"Log anomalies ({len(diff.log_anomalies)}):")
            for entry in diff.log_anomalies[:5]:
                parts.append(
                    f"  [{entry.get('source', '?')}] {entry.get('line', '')[:150]}"
                )
        if diff.disk_usage_changes:
            for dc in diff.disk_usage_changes[:3]:
                parts.append(
                    f"Disk {dc['mountpoint']}: "
                    f"{'+'if dc['delta_used_gb']>0 else ''}"
                    f"{dc['delta_used_gb']:.2f} GB → {dc['percent_now']:.0f}%"
                )
        if diff.new_databases:
            parts.append(
                f"New databases: "
                + ", ".join(d.get("name", "?") for d in diff.new_databases)
            )
        if diff.new_scheduled_tasks:
            parts.append(
                f"New scheduled tasks: "
                + ", ".join(t.get("name", "?") for t in diff.new_scheduled_tasks)
            )
        if diff.total_changes == 0:
            parts.append("No changes detected.")

        # Business context
        if self._brain.company_model:
            cm = self._brain.company_model
            parts.append(
                f"\nBusiness: {cm.get('business_type', 'unknown')} "
                f"({cm.get('industry', 'unknown')})"
            )

        # Current work status
        if self._brain.ranked_automations:
            parts.append(f"\nBacklog: {len(self._brain.ranked_automations)} tasks")
        if self._brain.completed_tasks:
            parts.append(f"Completed: {len(self._brain.completed_tasks)}")
        if self._brain.active_agent_sessions:
            parts.append(
                f"Active agents: "
                + ", ".join(s["agent_name"] for s in self._brain.active_agent_sessions)
            )

        return "\n".join(parts)

    # ------------------------------------------------------------------
    # Narration — real-time chat via Supabase
    # ------------------------------------------------------------------

    async def _narrate(self, content: str) -> None:
        """Post a narration message to the orchestrator chat."""
        self._sb.send_message(self._company_id, "orchestrator", content, "chat")

    async def _send(self, content: str, msg_type: str = "chat") -> None:
        """Alias kept for backward compatibility."""
        self._sb.send_message(self._company_id, "orchestrator", content, msg_type)

    # ------------------------------------------------------------------
    # Persistence & agent-status sync
    # ------------------------------------------------------------------

    _PHASE_TO_LTAN: dict[str, str] = {
        "installing": "looking",
        "discovering": "looking",
        "researching": "thinking",
        "ghost": "looking",
        "active": "acting",
    }

    async def _save_brain(self) -> None:
        raw = self._brain.model_dump()

        # LTAN phase for the dashboard Brain View
        ltan_phase = self._PHASE_TO_LTAN.get(self._brain.current_phase, "idle")
        if self._brain.current_phase == "active":
            if self._brain.active_tasks or self._brain.active_agent_sessions:
                ltan_phase = "acting"
            elif self._brain.ranked_automations:
                ltan_phase = "thinking"
            elif self._brain.pending_operations:
                ltan_phase = "thinking"
            else:
                ltan_phase = "looking"

        raw["ltan_phase"] = ltan_phase
        raw["ooda_phase"] = ltan_phase  # backward compat
        raw["cycle_number"] = self._brain.cycle_count
        raw["confidence"] = min(
            1.0, 0.1 * len(self._brain.completed_tasks) + 0.3,
        )

        # Priority queue for the dashboard
        queue_items: list[dict] = []
        for i, auto in enumerate(self._brain.ranked_automations[:20]):
            cand = auto.get("candidate", auto)
            queue_items.append({
                "rank": i + 1,
                "task": cand.get("name", "Unknown"),
                "description": (
                    cand.get("description") or cand.get("name", "Unknown")
                ),
                "score": auto.get("final_score", 0),
                "priority": auto.get("priority", "backlog"),
                "agent": self._select_agent_for_domain(cand.get("domain", "")),
                "status": auto.get("status", "pending"),
                "source": cand.get("source", "orchestrator"),
            })
        raw["priority_queue"] = queue_items

        # Observations for the thinking panel
        raw["observations"] = {
            "items": [
                {"label": "Phase", "value": self._brain.current_phase},
                {"label": "Sub-phase", "value": self._brain.active_subphase},
                {"label": "Active tasks", "value": len(self._brain.active_tasks)},
                {"label": "Active agents", "value": len(self._brain.active_agent_sessions)},
                {"label": "Completed", "value": len(self._brain.completed_tasks)},
                {"label": "Failed", "value": len(self._brain.failed_tasks)},
                {"label": "Backlog", "value": len(self._brain.ranked_automations)},
                {
                    "label": "Pending ops",
                    "value": len(self._brain.pending_operations),
                },
            ],
        }

        # System health from last observation
        if self._brain.last_snapshot:
            snap = self._brain.last_snapshot
            raw["system_health"] = {
                "cpu_percent": snap.get("cpu_percent", 0),
                "memory_used_percent": snap.get("memory_used_percent", 0),
                "process_count": snap.get("process_count", 0),
                "database_count": len(snap.get("databases", [])),
                "last_observed": snap.get("timestamp", ""),
                "scan_duration_ms": snap.get("scan_duration_ms", 0),
            }
        if self._brain.last_diff_summary:
            raw["last_diff"] = self._brain.last_diff_summary
        if self._brain.active_agent_sessions:
            raw["active_agents"] = self._brain.active_agent_sessions

        self._sb.save_brain_state(self._company_id, raw)

        # Keep orchestrator status row in sync
        active_task_name = (
            self._brain.active_tasks[0]["name"]
            if self._brain.active_tasks
            else (
                self._brain.active_agent_sessions[0]["task_name"]
                if self._brain.active_agent_sessions
                else "observing"
            )
        )
        self._sb.update_agent_status(
            self._company_id,
            "orchestrator",
            "running",
            f"Phase: {self._brain.current_phase} | "
            f"Cycle: {self._brain.cycle_count} | "
            f"Working on: {active_task_name}",
        )

    # ------------------------------------------------------------------
    # User message handling — LLM-powered contextual responses
    # ------------------------------------------------------------------

    async def handle_user_message(self, message: str) -> None:
        lower = message.lower()

        # Handle control commands directly
        if any(w in lower for w in ["pause", "stop", "hold"]):
            self._state.set_paused(True)
            await self._narrate(
                "Paused.  I'll stop all activity until you tell me to resume."
            )
            return
        if any(w in lower for w in ["resume", "continue", "go ahead"]):
            self._state.set_paused(False)
            await self._narrate("Resumed.  Getting back to work.")
            return

        # LLM-powered response with full context
        context = self._build_context_for_response()

        try:
            response = await self._llm.think(
                system_prompt=(
                    f"You are the orchestrator of Vincera, an autonomous AI agent "
                    f"system running for {self._config.company_name}.  You are the "
                    f"central brain — you directly observe the machine (processes, "
                    f"files, databases, logs, network), analyze everything, and "
                    f"spin up sub-agents (builder, operator, analyst, research, "
                    f"trainer, unstuck, discovery) for specialized work.  "
                    f"The user is chatting with you through a dashboard.  "
                    f"Be direct, specific, and helpful.  Reference real data from your "
                    f"current observations.  Keep responses concise (2-4 sentences max).\n\n"
                    f"Current state:\n{context}"
                ),
                user_message=message,
            )
            await self._narrate(response)
        except Exception:
            logger.exception("LLM response failed, using fallback")
            await self._narrate(self._get_status_summary())

    def _build_context_for_response(self) -> str:
        """Assemble current state as context for the LLM."""
        parts = [
            f"Phase: {self._brain.current_phase}",
            f"Sub-phase: {self._brain.active_subphase}",
            f"Cycle: {self._brain.cycle_count}",
            f"Active tasks: {len(self._brain.active_tasks)}",
            f"Active agents: {len(self._brain.active_agent_sessions)}",
            f"Completed tasks: {len(self._brain.completed_tasks)}",
            f"Failed tasks: {len(self._brain.failed_tasks)}",
            f"Backlog size: {len(self._brain.ranked_automations)}",
            f"Pending operations: {len(self._brain.pending_operations)}",
        ]

        # System observation data
        if self._brain.last_snapshot:
            snap = self._brain.last_snapshot
            parts.append(
                f"\nSystem: CPU {snap.get('cpu_percent', 0):.1f}%, "
                f"Memory {snap.get('memory_used_percent', 0):.1f}%, "
                f"Processes {snap.get('process_count', 0)}"
            )
        if self._brain.last_diff_summary:
            ds = self._brain.last_diff_summary
            parts.append(
                f"Last scan: {ds.get('total_changes', 0)} changes, "
                f"severity: {ds.get('severity', 'unknown')}"
            )

        if self._brain.active_tasks:
            parts.append("\nCurrently working on:")
            for t in self._brain.active_tasks:
                parts.append(
                    f"  - {t['name']} (agent: {t.get('agent')}, "
                    f"status: {t.get('status')})"
                )

        if self._brain.active_agent_sessions:
            parts.append("\nActive agents:")
            for s in self._brain.active_agent_sessions:
                parts.append(f"  - {s['agent_name']}: {s['task_name']}")

        if self._brain.completed_tasks:
            parts.append("\nRecently completed:")
            for t in self._brain.completed_tasks[-3:]:
                parts.append(f"  - {t['name']} ({t.get('status', 'done')})")

        if self._brain.ranked_automations:
            parts.append("\nNext in backlog:")
            for s in self._brain.ranked_automations[:3]:
                c = s.get("candidate", s)
                parts.append(
                    f"  - {c.get('name', 'unknown')} "
                    f"(score: {s.get('final_score', 0):.2f})"
                )

        if self._brain.company_model:
            cm = self._brain.company_model
            parts.append(f"\nBusiness type: {cm.get('business_type', 'unknown')}")
            parts.append(
                f"Software stack: {len(cm.get('software_stack', []))} tools detected"
            )
            parts.append(
                f"Processes found: {len(cm.get('detected_processes', []))}"
            )

        return "\n".join(parts)

    def _get_status_summary(self) -> str:
        return (
            f"Phase: {self._brain.current_phase} | "
            f"Cycle: {self._brain.cycle_count} | "
            f"Active agents: {len(self._brain.active_agent_sessions)} | "
            f"Completed: {len(self._brain.completed_tasks)} | "
            f"Backlog: {len(self._brain.ranked_automations)}"
        )

    def _get_backlog_summary(self) -> str:
        if not self._brain.ranked_automations:
            return "No automations in backlog yet."
        top = self._brain.ranked_automations[:5]
        lines = ["Top prioritized automations:"]
        for i, s in enumerate(top, 1):
            c = s.get("candidate", s)
            name = c.get("name", "unknown")
            score = s.get("final_score", 0)
            lines.append(f"{i}. {name} (score: {score:.2f})")
        return "\n".join(lines)
