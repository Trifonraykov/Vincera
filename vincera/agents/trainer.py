"""Trainer Agent — learns from corrections and improves agent behaviour over time."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from vincera.agents.base import BaseAgent

if TYPE_CHECKING:
    from vincera.config import VinceraSettings
    from vincera.core.llm import OpenRouterClient
    from vincera.core.state import GlobalState
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.training.corrections import CorrectionTracker
    from vincera.training.trainer import TrainingEngine
    from vincera.verification.verifier import Verifier

logger = logging.getLogger(__name__)


class TrainerAgent(BaseAgent):
    """Uses corrections + playbook data to improve agent behaviour."""

    def __init__(
        self,
        name: str,
        company_id: str,
        config: "VinceraSettings",
        llm: "OpenRouterClient",
        supabase: "SupabaseManager",
        state: "GlobalState",
        verifier: "Verifier",
        correction_tracker: "CorrectionTracker",
        training_engine: "TrainingEngine",
    ) -> None:
        super().__init__(name, company_id, config, llm, supabase, state, verifier)
        self._corrections = correction_tracker
        self._engine = training_engine

    # ------------------------------------------------------------------
    # Main dispatch
    # ------------------------------------------------------------------

    async def run(self, task: dict) -> dict:
        """Run a training task.

        Task types:
        - {"type": "record_correction", "agent_name": str, "original_action": str, "correction_text": str}
        - {"type": "train_agent", "agent_name": str}
        - {"type": "full_training_cycle"}
        - {"type": "find_patterns"}
        """
        task_type = task.get("type", "")

        if task_type == "record_correction":
            return await self._record_correction(task)
        elif task_type == "train_agent":
            return await self._train_agent(task)
        elif task_type == "full_training_cycle":
            return await self._full_training_cycle()
        elif task_type == "find_patterns":
            return await self._find_patterns()
        else:
            return {"status": "error", "reason": f"Unknown task type: {task_type}"}

    # ------------------------------------------------------------------
    # Record correction
    # ------------------------------------------------------------------

    async def _record_correction(self, task: dict) -> dict:
        agent_name = task["agent_name"]
        original = task["original_action"]
        correction_text = task["correction_text"]

        result = await self._corrections.record_correction(agent_name, original, correction_text)

        await self.send_message(
            f"Noted. Correction recorded for {agent_name}: '{result.corrected_action}' "
            f"(category: {result.category}, severity: {result.severity}). "
            f"I'll make sure this doesn't happen again.",
            message_type="chat",
        )

        return {
            "status": "recorded",
            "correction_id": result.correction_id,
            "category": result.category,
        }

    # ------------------------------------------------------------------
    # Train single agent
    # ------------------------------------------------------------------

    async def _train_agent(self, task: dict) -> dict:
        agent_name = task["agent_name"]

        corrections = await self._corrections.get_corrections_for_agent(agent_name)
        playbook_entries = self._sb.query_playbook(self.company_id, agent_name, [], 50) or []

        profile = await self._engine.analyze_agent(agent_name, corrections, playbook_entries)

        for c in corrections:
            cid = c.get("correction_id")
            if cid:
                await self._corrections.mark_applied(cid)

        await self.send_message(
            f"Training complete for {agent_name}:\n"
            f"- Success rate: {profile.success_rate:.0%}\n"
            f"- Corrections applied: {profile.correction_count}\n"
            f"- New rules learned: {len(profile.custom_instructions)}\n"
            f"- Common mistakes identified: "
            f"{', '.join(profile.common_mistakes[:3]) if profile.common_mistakes else 'none'}",
            message_type="chat",
        )

        return {
            "status": "trained",
            "agent": agent_name,
            "corrections_applied": len(corrections),
            "rules_learned": len(profile.custom_instructions),
            "success_rate": profile.success_rate,
        }

    # ------------------------------------------------------------------
    # Full training cycle
    # ------------------------------------------------------------------

    async def _full_training_cycle(self) -> dict:
        """Train all agents that have corrections."""
        all_corrections = await self._corrections.get_all_corrections()

        agents_with_corrections = {c.get("agent_name", "") for c in all_corrections}
        agents_with_corrections.discard("")

        await self.send_message(
            f"Starting full training cycle. {len(all_corrections)} corrections across "
            f"{len(agents_with_corrections)} agents.",
            message_type="chat",
        )

        profiles = []
        for agent_name in agents_with_corrections:
            agent_corrections = [c for c in all_corrections if c.get("agent_name") == agent_name]
            playbook_entries = self._sb.query_playbook(self.company_id, agent_name, [], 50) or []
            profile = await self._engine.analyze_agent(agent_name, agent_corrections, playbook_entries)
            profiles.append(profile)

        recommendations = await self._engine.generate_recommendations(profiles)
        high_priority = [r for r in recommendations if r.priority == "high"]

        narration = f"Training cycle complete. Analysed {len(profiles)} agents.\n"
        if high_priority:
            narration += "\nHigh-priority recommendations:\n"
            for i, r in enumerate(high_priority[:5], 1):
                narration += f"{i}. [{r.agent_name}] {r.description}\n"
        if not recommendations:
            narration += "No systemic issues found. All agents performing within expectations."

        await self.send_message(narration, message_type="chat")

        await self.record_to_playbook(
            "full_training",
            "Train all agents",
            f"Analysed {len(profiles)} agents",
            f"{len(recommendations)} recommendations, {len(high_priority)} high priority",
            True,
            "",
        )

        return {
            "status": "complete",
            "agents_trained": len(profiles),
            "total_corrections": len(all_corrections),
            "recommendations": len(recommendations),
            "high_priority": len(high_priority),
        }

    # ------------------------------------------------------------------
    # Find patterns
    # ------------------------------------------------------------------

    async def _find_patterns(self) -> dict:
        patterns = await self._corrections.find_patterns()

        if patterns:
            narration = f"Found {len(patterns)} correction patterns:\n"
            for i, p in enumerate(patterns[:5], 1):
                narration += f"{i}. {p.get('pattern', 'Unknown')} (frequency: {p.get('frequency', '?')})\n"
                narration += f"   Fix: {p.get('suggested_fix', 'N/A')}\n"
            await self.send_message(narration, message_type="chat")
        else:
            await self.send_message(
                "Not enough corrections yet to identify patterns.",
                message_type="chat",
            )

        return {
            "status": "complete",
            "patterns_found": len(patterns),
            "patterns": patterns,
        }
