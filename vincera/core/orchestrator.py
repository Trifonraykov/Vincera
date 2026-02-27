"""Orchestrator — the always-on central brain of Vincera.

The orchestrator NEVER stops.  It continuously:
1.  Maps and understands the company (owns discovery + company model)
2.  Processes automation tasks from the backlog (delegates to builder)
3.  Manages post-completion follow-up (operator for canary/run, analyst for review)
4.  Seeks new automation opportunities (re-discovery, research, LLM ideation)
5.  Narrates everything it does in real-time chat (via OpenRouter)
6.  Requires human approval for sensitive / risky operations
"""

from __future__ import annotations

import json
import logging
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
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.verification.verifier import Verifier

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Brain state
# ---------------------------------------------------------------------------

class OrchestratorState(BaseModel):
    """Serializable brain state — survives restarts."""

    current_phase: str = "installing"
    active_subphase: str = "working"  # working | post_completion | seeking
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


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class Orchestrator:
    """Central coordinator that drives all autonomous behaviour.

    The orchestrator is the single brain responsible for:
    -  Mapping and understanding the company (via discovery agent)
    -  Continuously finding automation opportunities
    -  Delegating work to the right sub-agents
    -  Narrating everything in real-time via chat
    -  Requiring human approval for sensitive operations
    -  NEVER stopping — when the backlog runs out it actively looks for more
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
    # Phases
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
            self._brain.active_subphase = "working"
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
                self._brain.active_subphase = "working"
                await self._build_initial_backlog()
                await self._save_brain()
                return {"action": "phase_transition", "from": "ghost", "to": "active"}

        return {"action": "observing", "days_remaining": self._ghost.days_remaining}

    # ==================================================================
    # ACTIVE PHASE — THE ALWAYS-ON WORK LOOP
    # ==================================================================

    async def _phase_active(self) -> dict:
        """The active phase **never** stops.  It continuously:
        1.  Dispatches pending follow-up operations (operator, analyst, unstuck)
        2.  Processes backlog tasks (delegates to builder / relevant agent)
        3.  Seeks new opportunities when the backlog is empty
        4.  Narrates every decision and observation in real-time
        """

        if not self._authority.can_act():
            return {"action": "blocked", "reason": "Authority level does not permit action"}

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
            # Truly nothing on first attempt
            await self._narrate(
                "I've scanned your system but couldn't identify any automation "
                "opportunities right now.  I'll keep monitoring and looking.  "
                "You can also tell me what processes you want automated."
            )
            return {"action": "idle", "reason": "No automations found"}

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
                f"ATTENTION — The next task **{task.candidate.name}** involves sensitive data.\n"
                f"Reason: {sensitivity_reason}\n"
                f"Risk level: **{risk.value}**\n"
                f"I need your approval before proceeding."
            )

        # --- Select agent -------------------------------------------------
        agent_name = self._select_agent_for_task(task)
        if not agent_name or agent_name not in self._agents:
            await self._narrate(
                f"I want to work on \"{task.candidate.name}\" but no agent is "
                f"available for domain '{task.candidate.domain}'.  Skipping for now."
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
                f"You denied \"{task.candidate.name}\".  "
                f"I understand — moving on to the next item."
            )
            self._remove_from_backlog(task.candidate.name)
            await self._save_brain()
            return {"action": "task_denied", "task": task.candidate.name}

        # --- NARRATE what we're about to do -------------------------------
        await self._narrate(
            f"Starting work on: **{task.candidate.name}**\n"
            f"Score: {task.final_score:.2f} | Risk: {risk.value} | "
            f"Delegating to: **{agent_name}**\n\n"
            f"What this does: {task.candidate.description}\n"
            f"Expected time savings: ~{task.candidate.estimated_hours_saved_weekly}h/week"
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
            self._remove_from_backlog(task.candidate.name)

            # Queue follow-up operations
            self._queue_post_completion(task_record, result)

            status = result.get("status", "unknown")
            await self._narrate(
                f"Completed: **{task.candidate.name}** (status: {status})\n"
                f"Agent **{agent_name}** finished the work.  "
                f"Remaining in backlog: {len(self._brain.ranked_automations)}\n"
                f"I'll now set up monitoring and run follow-up checks."
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
            self._remove_from_backlog(task.candidate.name)

            # Queue unstuck agent to diagnose
            self._queue_unstuck_diagnosis(task_record, error_str)

            await self._narrate(
                f"Failed: **{task.candidate.name}**\n"
                f"Error: {error_str}\n"
                f"I'm dispatching the unstuck agent to diagnose and attempt a fix.  "
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
            f"Running follow-up: **{op.get('description', op_type)}**\n"
            f"Delegating to: **{agent_name}**"
        )

        try:
            result = await self._agents[agent_name].execute(op.get("task", {}))
            await self._narrate(
                f"Follow-up complete: **{op.get('description', op_type)}** — "
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
                f"Follow-up task failed: {op.get('description', op_type)} — "
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
            "Running periodic system scan.  Looking for new software, files, "
            "processes, or configuration changes..."
        )
        try:
            result = await self._agents["discovery"].execute({"mode": "periodic"})
            self._brain.last_discovery_at = now.isoformat()
            await self._rebuild_backlog()

            if self._brain.ranked_automations:
                await self._narrate(
                    f"Periodic scan complete.  Found "
                    f"**{len(self._brain.ranked_automations)} new automation "
                    f"opportunities**!  Getting back to work."
                )
            else:
                await self._narrate(
                    "Periodic scan complete.  No new opportunities found this cycle.  "
                    "I'll check again soon."
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
            "Running performance analysis on completed automations.  "
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
            "Running a training cycle to learn from recent corrections.  "
            "Improving agent behaviour patterns..."
        )
        try:
            result = await self._agents["trainer"].execute(
                {"type": "full_training_cycle"},
            )
            self._brain.last_training_at = now.isoformat()
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
                lines.append("\nAdding these to my backlog.  Let me get to work.")
                await self._narrate("\n".join(lines))
            else:
                await self._narrate(
                    "Couldn't identify any new opportunities right now.  "
                    "I'll keep monitoring your system for changes."
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
    # Narration — real-time chat via OpenRouter
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

    _PHASE_TO_OODA: dict[str, str] = {
        "installing": "observing",
        "discovering": "observing",
        "researching": "orienting",
        "ghost": "observing",
        "active": "acting",
    }

    async def _save_brain(self) -> None:
        raw = self._brain.model_dump()

        # OODA phase for the dashboard Brain View
        ooda_phase = self._PHASE_TO_OODA.get(self._brain.current_phase, "idle")
        if self._brain.current_phase == "active":
            if self._brain.active_tasks:
                ooda_phase = "acting"
            elif self._brain.ranked_automations:
                ooda_phase = "deciding"
            elif self._brain.pending_operations:
                ooda_phase = "orienting"
            else:
                ooda_phase = "observing"

        raw["ooda_phase"] = ooda_phase
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
                {"label": "Completed", "value": len(self._brain.completed_tasks)},
                {"label": "Failed", "value": len(self._brain.failed_tasks)},
                {"label": "Backlog", "value": len(self._brain.ranked_automations)},
                {
                    "label": "Pending ops",
                    "value": len(self._brain.pending_operations),
                },
            ],
        }

        self._sb.save_brain_state(self._company_id, raw)

        # Keep orchestrator status row in sync
        active_task_name = (
            self._brain.active_tasks[0]["name"]
            if self._brain.active_tasks
            else "idle"
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
                    f"central brain — you map company data, analyse operations, find "
                    f"automation opportunities, and delegate work to sub-agents "
                    f"(builder, operator, analyst, research, trainer, unstuck, "
                    f"discovery).  The user is chatting with you through a dashboard.  "
                    f"Be direct, specific, and helpful.  Reference real data from your "
                    f"current state.  Keep responses concise (2-4 sentences max).\n\n"
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
            f"Completed tasks: {len(self._brain.completed_tasks)}",
            f"Failed tasks: {len(self._brain.failed_tasks)}",
            f"Backlog size: {len(self._brain.ranked_automations)}",
            f"Pending operations: {len(self._brain.pending_operations)}",
        ]

        if self._brain.active_tasks:
            parts.append("\nCurrently working on:")
            for t in self._brain.active_tasks:
                parts.append(
                    f"  - {t['name']} (agent: {t.get('agent')}, "
                    f"status: {t.get('status')})"
                )

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
            f"Active tasks: {len(self._brain.active_tasks)} | "
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
