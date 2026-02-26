"""Orchestrator — the central decision-making brain of Vincera."""

from __future__ import annotations

import json
import logging
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

    async def _phase_active(self) -> dict:
        if not self._authority.can_act():
            return {"action": "blocked", "reason": "Authority level does not permit action"}

        if not self._brain.ranked_automations:
            await self._build_initial_backlog()

        batch = self._priority.get_next_batch(
            [ScoredCandidate(**s) for s in self._brain.ranked_automations],
            batch_size=1,
        )

        if not batch:
            return {"action": "idle", "reason": "No automations in backlog"}

        task = batch[0]

        risk = self._authority.classify_risk(
            task.candidate.description,
            affects_financial=task.candidate.affects_financial_data,
            affects_customer=task.candidate.affects_customer_data,
            is_reversible=task.candidate.reversible,
            modifies_system=task.candidate.requires_system_modification,
        )

        agent_name = self._select_agent(task)
        if agent_name and agent_name in self._agents:
            approved = await self._authority.request_if_needed(
                self._agents[agent_name],
                task.candidate.name,
                risk,
                context=task.candidate.description,
            )
            if approved:
                task_record = {
                    "name": task.candidate.name,
                    "agent": agent_name,
                    "status": "assigned",
                    "risk": risk.value,
                }
                self._brain.active_tasks.append(task_record)
                await self._save_brain()
                return {
                    "action": "task_assigned",
                    "task": task.candidate.name,
                    "agent": agent_name,
                    "risk": risk.value,
                }
            return {
                "action": "task_denied",
                "task": task.candidate.name,
                "reason": "User denied approval",
            }

        return {
            "action": "no_agent",
            "task": task.candidate.name,
            "reason": f"No agent available for domain {task.candidate.domain}",
        }

    # ------------------------------------------------------------------
    # Agent selection
    # ------------------------------------------------------------------

    def _select_agent(self, task: ScoredCandidate) -> str | None:
        DOMAIN_AGENTS = {
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
        }
        return DOMAIN_AGENTS.get(task.candidate.domain)

    # ------------------------------------------------------------------
    # Backlog management
    # ------------------------------------------------------------------

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

        top_names = ", ".join(s.candidate.name for s in ranked[:3]) if ranked else "none"
        await self._send(
            f"Built automation backlog: {len(ranked)} candidates prioritized. Top 3: {top_names}",
            "system",
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

    async def _save_brain(self) -> None:
        self._sb.save_brain_state(self._company_id, self._brain.model_dump())

    async def _send(self, content: str, msg_type: str = "chat") -> None:
        self._sb.send_message(self._company_id, "orchestrator", content, msg_type)

    # ------------------------------------------------------------------
    # User message handling
    # ------------------------------------------------------------------

    async def handle_user_message(self, message: str) -> None:
        lower = message.lower()
        if any(w in lower for w in ["status", "what are you doing", "progress"]):
            await self._send(self._get_status_summary())
        elif any(w in lower for w in ["pause", "stop", "hold"]):
            self._state.set_paused(True)
            await self._send("Paused. I'll stop all activity until you resume me.")
        elif any(w in lower for w in ["resume", "continue", "go"]):
            self._state.set_paused(False)
            await self._send("Resumed. Getting back to work.")
        elif any(w in lower for w in ["priority", "backlog", "what's next"]):
            await self._send(self._get_backlog_summary())
        else:
            await self._send(
                f"I heard you. Currently in {self._brain.current_phase} phase. "
                f"I'll address this as I work through my tasks."
            )

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
