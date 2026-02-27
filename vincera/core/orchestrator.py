"""Orchestrator — the central decision-making brain of Vincera."""

from __future__ import annotations

import json
import logging
import traceback
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
    company_model: dict | None = None
    ontology_mapping: dict | None = None
    ranked_automations: list[dict] = []
    active_tasks: list[dict] = []
    completed_tasks: list[dict] = []
    failed_tasks: list[dict] = []
    cycle_count: int = 0


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class Orchestrator:
    """Central coordinator that drives all autonomous behaviour."""

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
        # Restore ghost mode timer so it survives restarts
        self._ghost.load_state(self._company_id)

        saved = self._sb.get_latest_brain_state(self._company_id)
        if saved:
            self._brain = OrchestratorState(**saved)
            await self._send(
                f"Vincera restarted. Resuming from phase: {self._brain.current_phase}.",
                "system",
            )
        else:
            self._brain = OrchestratorState(current_phase="installing")

    async def run_cycle(self) -> dict:
        """One decision cycle. Called repeatedly by the Scheduler."""
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
            await agent.execute({"mode": "initial"})

        self._brain.current_phase = "researching"
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
            await self._build_initial_backlog()
            await self._save_brain()
            return {"action": "phase_transition", "from": "ghost", "to": "active",
                    "note": "ghost mode disabled (0 days)"}

        if not self._ghost.is_active:
            if self._ghost.start_date is None:
                await self._ghost.start(self._company_id, self._config.ghost_mode_days)
                return {"action": "ghost_started", "days": self._config.ghost_mode_days}

            if await self._ghost.should_end(self._company_id):
                await self._ghost.end(self._company_id)
                self._brain.current_phase = "active"
                await self._build_initial_backlog()
                await self._save_brain()
                return {"action": "phase_transition", "from": "ghost", "to": "active"}

        return {"action": "observing", "days_remaining": self._ghost.days_remaining}

    # ------------------------------------------------------------------
    # Active phase — the real work loop
    # ------------------------------------------------------------------

    async def _phase_active(self) -> dict:
        """Execute the active phase: pick tasks, dispatch to agents, report results."""

        if not self._authority.can_act():
            return {"action": "blocked", "reason": "Authority level does not permit action"}

        # Build backlog on first entry
        if not self._brain.ranked_automations and not self._brain.completed_tasks:
            await self._build_initial_backlog()
            if not self._brain.ranked_automations:
                await self._send(
                    "I've scanned your system but couldn't identify any automation "
                    "opportunities right now. Tell me what processes you want automated "
                    "and I'll get to work."
                )
                return {"action": "idle", "reason": "No automations found"}

        # If backlog is empty but we've completed tasks, we're done for now
        if not self._brain.ranked_automations:
            await self._send(
                f"All {len(self._brain.completed_tasks)} automation(s) in my backlog "
                f"have been processed. Tell me what else you'd like me to work on."
            )
            await self._save_brain()
            return {"action": "all_complete", "completed": len(self._brain.completed_tasks)}

        # Skip tasks we already completed or failed
        completed_names = {t["name"] for t in self._brain.completed_tasks}
        failed_names = {t["name"] for t in self._brain.failed_tasks}
        self._brain.ranked_automations = [
            r for r in self._brain.ranked_automations
            if r.get("candidate", r).get("name") not in completed_names
            and r.get("candidate", r).get("name") not in failed_names
        ]
        if not self._brain.ranked_automations:
            await self._save_brain()
            return {"action": "all_complete", "completed": len(self._brain.completed_tasks)}

        # Pick the highest-priority task
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

        # Risk classification
        risk = self._authority.classify_risk(
            task.candidate.description,
            affects_financial=task.candidate.affects_financial_data,
            affects_customer=task.candidate.affects_customer_data,
            is_reversible=task.candidate.reversible,
            modifies_system=task.candidate.requires_system_modification,
        )

        # Select agent
        agent_name = self._select_agent(task)
        if not agent_name or agent_name not in self._agents:
            await self._send(
                f"I want to work on \"{task.candidate.name}\" but no agent is "
                f"available for domain '{task.candidate.domain}'. Skipping."
            )
            self._remove_from_backlog(task.candidate.name)
            await self._save_brain()
            return {"action": "no_agent", "task": task.candidate.name}

        # Get approval if needed
        approved = await self._authority.request_if_needed(
            self._agents[agent_name],
            task.candidate.name,
            risk,
            context=task.candidate.description,
        )
        if not approved:
            await self._send(
                f"You denied \"{task.candidate.name}\". Moving on to the next item."
            )
            self._remove_from_backlog(task.candidate.name)
            await self._save_brain()
            return {"action": "task_denied", "task": task.candidate.name}

        # ---- NARRATE: Tell the user what we're about to do ----
        await self._send(
            f"Starting work on: **{task.candidate.name}**\n"
            f"Score: {task.final_score:.2f} | Risk: {risk.value} | "
            f"Delegating to: {agent_name}\n\n"
            f"{task.candidate.description}"
        )

        # Track as active
        task_record = {
            "name": task.candidate.name,
            "agent": agent_name,
            "status": "in_progress",
            "risk": risk.value,
            "description": task.candidate.description,
        }
        self._brain.active_tasks.append(task_record)
        await self._save_brain()

        # ---- DISPATCH: Actually run the agent ----
        agent_task = {
            "name": task.candidate.name,
            "description": task.candidate.description,
            "business_context": (
                f"Company: {self._config.company_name}. "
                f"Priority: {task.priority}. "
                f"Estimated hours saved: {task.candidate.estimated_hours_saved_weekly}/week."
            ),
            "constraints": [],
        }

        try:
            result = await self._agents[agent_name].execute(agent_task)

            # ---- SUCCESS ----
            task_record["status"] = "completed"
            task_record["result"] = result
            self._brain.completed_tasks.append(task_record)
            self._brain.active_tasks = [
                t for t in self._brain.active_tasks
                if t.get("name") != task.candidate.name
            ]
            self._remove_from_backlog(task.candidate.name)

            status = result.get("status", "unknown")
            await self._send(
                f"Completed: **{task.candidate.name}**\n"
                f"Status: {status}\n"
                f"Agent {agent_name} finished the work. "
                f"({len(self._brain.ranked_automations)} remaining in backlog)"
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
            logger.exception("Agent %s failed on task %s", agent_name, task.candidate.name)
            error_str = str(exc)[:500]
            task_record["status"] = "failed"
            task_record["error"] = error_str
            self._brain.failed_tasks.append(task_record)
            self._brain.active_tasks = [
                t for t in self._brain.active_tasks
                if t.get("name") != task.candidate.name
            ]
            self._remove_from_backlog(task.candidate.name)

            await self._send(
                f"Failed: **{task.candidate.name}**\n"
                f"Error: {error_str}\n"
                f"I'll move on to the next task. "
                f"({len(self._brain.ranked_automations)} remaining in backlog)"
            )
            await self._save_brain()
            return {
                "action": "task_failed",
                "task": task.candidate.name,
                "agent": agent_name,
                "error": error_str,
            }

    # ------------------------------------------------------------------
    # Agent selection
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
        return self._DOMAIN_AGENTS.get(task.candidate.domain)

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
            lines = [f"I've identified {len(ranked)} automation opportunity(s). Here's my plan:\n"]
            for i, s in enumerate(ranked, 1):
                lines.append(
                    f"{i}. **{s.candidate.name}** — score {s.final_score:.2f}, "
                    f"priority: {s.priority}\n   {s.candidate.description}"
                )
            lines.append("\nI'll start working through these now, highest priority first.")
            await self._send("\n".join(lines))
        else:
            await self._send(
                "I analysed your system but couldn't find concrete automation opportunities yet. "
                "Tell me about repetitive tasks you'd like me to automate."
            )

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
    # Persistence & messaging
    # ------------------------------------------------------------------

    # Map internal phases to OODA phases the dashboard understands
    _PHASE_TO_OODA: dict[str, str] = {
        "installing": "observing",
        "discovering": "observing",
        "researching": "orienting",
        "ghost": "observing",
        "active": "acting",
    }

    async def _save_brain(self) -> None:
        raw = self._brain.model_dump()
        # Enrich with OODA fields that the dashboard Brain View expects
        ooda_phase = self._PHASE_TO_OODA.get(self._brain.current_phase, "idle")
        # Refine OODA for active sub-states
        if self._brain.current_phase == "active":
            if self._brain.active_tasks:
                ooda_phase = "acting"
            elif self._brain.ranked_automations:
                ooda_phase = "deciding"
            else:
                ooda_phase = "observing"

        raw["ooda_phase"] = ooda_phase
        raw["cycle_number"] = self._brain.cycle_count
        raw["confidence"] = min(1.0, 0.1 * len(self._brain.completed_tasks) + 0.3)
        # Map ranked_automations → priority_queue for the dashboard
        # ScoredCandidate.model_dump() nests data under "candidate" key
        queue_items = []
        for i, auto in enumerate(self._brain.ranked_automations[:20]):
            cand = auto.get("candidate", auto)
            queue_items.append({
                "rank": i + 1,
                "task": cand.get("name", "Unknown"),
                "description": cand.get("description") or cand.get("name", "Unknown"),
                "score": auto.get("final_score", 0),
                "priority": auto.get("priority", "backlog"),
                "agent": self._select_agent_for_domain(cand.get("domain", "")),
                "status": auto.get("status", "pending"),
                "source": cand.get("source", "orchestrator"),
            })
        raw["priority_queue"] = queue_items
        # Map phase-specific observations for the thinking panel
        raw["observations"] = {
            "items": [
                {"label": "Phase", "value": self._brain.current_phase},
                {"label": "Active tasks", "value": len(self._brain.active_tasks)},
                {"label": "Completed", "value": len(self._brain.completed_tasks)},
                {"label": "Failed", "value": len(self._brain.failed_tasks)},
                {"label": "Backlog", "value": len(self._brain.ranked_automations)},
            ]
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
            f"Phase: {self._brain.current_phase} | Cycle: {self._brain.cycle_count} | "
            f"Working on: {active_task_name}",
        )

    async def _send(self, content: str, msg_type: str = "chat") -> None:
        self._sb.send_message(self._company_id, "orchestrator", content, msg_type)

    # ------------------------------------------------------------------
    # User message handling — LLM-powered contextual responses
    # ------------------------------------------------------------------

    async def handle_user_message(self, message: str) -> None:
        lower = message.lower()

        # Handle control commands directly (no LLM needed)
        if any(w in lower for w in ["pause", "stop", "hold"]):
            self._state.set_paused(True)
            await self._send("Paused. I'll stop all activity until you tell me to resume.")
            return
        if any(w in lower for w in ["resume", "continue", "go ahead"]):
            self._state.set_paused(False)
            await self._send("Resumed. Getting back to work.")
            return

        # Build context for the LLM
        context = self._build_context_for_response()

        try:
            response = await self._llm.think(
                system_prompt=(
                    f"You are the orchestrator of Vincera, an autonomous AI agent system "
                    f"running for {self._config.company_name}. The user is chatting with you "
                    f"through a dashboard. Be direct, specific, and helpful. Reference real "
                    f"data from your current state. Keep responses concise (2-4 sentences max).\n\n"
                    f"Current state:\n{context}"
                ),
                user_message=message,
            )
            await self._send(response)
        except Exception:
            logger.exception("LLM response failed, using fallback")
            await self._send(self._get_status_summary())

    def _build_context_for_response(self) -> str:
        """Assemble current state as context for the LLM."""
        parts = [
            f"Phase: {self._brain.current_phase}",
            f"Cycle: {self._brain.cycle_count}",
            f"Active tasks: {len(self._brain.active_tasks)}",
            f"Completed tasks: {len(self._brain.completed_tasks)}",
            f"Failed tasks: {len(self._brain.failed_tasks)}",
            f"Backlog size: {len(self._brain.ranked_automations)}",
        ]

        if self._brain.active_tasks:
            parts.append("\nCurrently working on:")
            for t in self._brain.active_tasks:
                parts.append(f"  - {t['name']} (agent: {t.get('agent')}, status: {t.get('status')})")

        if self._brain.completed_tasks:
            parts.append("\nRecently completed:")
            for t in self._brain.completed_tasks[-3:]:
                parts.append(f"  - {t['name']} ({t.get('status', 'done')})")

        if self._brain.ranked_automations:
            parts.append("\nNext in backlog:")
            for s in self._brain.ranked_automations[:3]:
                c = s.get("candidate", s)
                parts.append(f"  - {c.get('name', 'unknown')} (score: {s.get('final_score', 0):.2f})")

        if self._brain.company_model:
            cm = self._brain.company_model
            parts.append(f"\nBusiness type: {cm.get('business_type', 'unknown')}")
            parts.append(f"Software stack: {len(cm.get('software_stack', []))} tools detected")
            parts.append(f"Processes found: {len(cm.get('detected_processes', []))}")

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
