"""Training engine — analyses agent performance and generates improvement recommendations."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.core.llm import OpenRouterClient
    from vincera.knowledge.playbook import PlaybookManager
    from vincera.knowledge.supabase_client import SupabaseManager

logger = logging.getLogger(__name__)


class TrainingRecommendation(BaseModel):
    """A system-wide training recommendation."""

    agent_name: str
    recommendation_type: str  # prompt_update, behavior_change, new_rule, escalation_change
    description: str
    priority: str  # low, medium, high
    based_on: list[str] = []


class AgentProfile(BaseModel):
    """Accumulated learnings for a specific agent."""

    agent_name: str
    correction_count: int = 0
    success_rate: float = 0.0
    common_mistakes: list[str] = []
    strengths: list[str] = []
    custom_instructions: list[str] = []
    last_trained: str | None = None


class TrainingEngine:
    """Uses corrections and playbook data to generate improved prompts and identify areas for improvement."""

    def __init__(
        self,
        llm: "OpenRouterClient",
        supabase: "SupabaseManager",
        playbook: "PlaybookManager",
        company_id: str,
    ) -> None:
        self._llm = llm
        self._sb = supabase
        self._playbook = playbook
        self._company_id = company_id
        self._profiles: dict[str, AgentProfile] = {}

    # ------------------------------------------------------------------
    # Analyse
    # ------------------------------------------------------------------

    async def analyze_agent(
        self,
        agent_name: str,
        corrections: list[dict],
        playbook_entries: list[dict],
    ) -> AgentProfile:
        """Build / update profile for an agent based on corrections and playbook."""
        success_count = sum(1 for p in playbook_entries if p.get("success"))
        total = len(playbook_entries) if playbook_entries else 1

        corrections_text = "\n".join(
            f"- {c.get('category')}: {c.get('correction_text', '')[:80]}"
            for c in corrections[:10]
        )
        playbook_text = "\n".join(
            f"- {p.get('task', '')}: {'success' if p.get('success') else 'failed'}"
            for p in playbook_entries[:10]
        )

        analysis = await self._llm.think_structured(
            f"You analyse the performance of AI agents and identify patterns.",
            f"Analyse the performance of the '{agent_name}' agent:\n\n"
            f"Corrections ({len(corrections)}):\n{corrections_text}\n\n"
            f"Playbook entries ({len(playbook_entries)}):\n{playbook_text}\n\n"
            f"Provide:\n"
            f"- common_mistakes: list of recurring mistake patterns\n"
            f"- strengths: what this agent does well\n"
            f"- custom_instructions: specific rules to add to this agent's prompts to prevent past mistakes",
            {
                "type": "object",
                "properties": {
                    "common_mistakes": {"type": "array", "items": {"type": "string"}},
                    "strengths": {"type": "array", "items": {"type": "string"}},
                    "custom_instructions": {"type": "array", "items": {"type": "string"}},
                },
            },
        )

        is_dict = isinstance(analysis, dict)

        profile = AgentProfile(
            agent_name=agent_name,
            correction_count=len(corrections),
            success_rate=round(success_count / total, 2),
            common_mistakes=analysis.get("common_mistakes", []) if is_dict else [],
            strengths=analysis.get("strengths", []) if is_dict else [],
            custom_instructions=analysis.get("custom_instructions", []) if is_dict else [],
            last_trained=datetime.now(timezone.utc).isoformat(),
        )

        self._profiles[agent_name] = profile
        return profile

    # ------------------------------------------------------------------
    # Recommendations
    # ------------------------------------------------------------------

    async def generate_recommendations(
        self,
        profiles: list[AgentProfile],
    ) -> list[TrainingRecommendation]:
        """Generate system-wide training recommendations."""
        if not profiles:
            return []

        profile_summary = "\n".join(
            f"- {p.agent_name}: {p.correction_count} corrections, {p.success_rate:.0%} success rate, "
            f"mistakes: {', '.join(p.common_mistakes[:3])}"
            for p in profiles
        )

        result = await self._llm.think_structured(
            "You generate training recommendations for AI agents based on their performance profiles.",
            f"Based on these agent profiles, generate training recommendations:\n\n"
            f"{profile_summary}\n\n"
            f"For each recommendation provide:\n"
            f"- agent_name: which agent (or 'all' for system-wide)\n"
            f"- recommendation_type: prompt_update, behavior_change, new_rule, or escalation_change\n"
            f"- description: what to change\n"
            f"- priority: low, medium, or high",
            {
                "type": "object",
                "properties": {
                    "recommendations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "agent_name": {"type": "string"},
                                "recommendation_type": {"type": "string"},
                                "description": {"type": "string"},
                                "priority": {"type": "string"},
                            },
                        },
                    },
                },
            },
        )

        recs = result.get("recommendations", []) if isinstance(result, dict) else []
        return [
            TrainingRecommendation(
                agent_name=r.get("agent_name", "all"),
                recommendation_type=r.get("recommendation_type", "behavior_change"),
                description=r.get("description", ""),
                priority=r.get("priority", "medium"),
            )
            for r in recs
        ]

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------

    def get_agent_instructions(self, agent_name: str) -> str:
        """Get custom instructions for an agent based on training profile."""
        profile = self._profiles.get(agent_name)
        if not profile or not profile.custom_instructions:
            return ""

        lines = [f"LEARNED RULES for {agent_name}:"]
        for instruction in profile.custom_instructions:
            lines.append(f"- {instruction}")
        return "\n".join(lines)

    def get_profile(self, agent_name: str) -> AgentProfile | None:
        return self._profiles.get(agent_name)

    def get_all_profiles(self) -> list[AgentProfile]:
        return list(self._profiles.values())
