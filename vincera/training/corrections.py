"""Correction tracker — captures, stores, and retrieves user corrections."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.core.llm import OpenRouterClient
    from vincera.knowledge.supabase_client import SupabaseManager

logger = logging.getLogger(__name__)


class Correction(BaseModel):
    """A single user correction to an agent's behaviour."""

    correction_id: str
    company_id: str
    agent_name: str
    original_action: str
    correction_text: str
    corrected_action: str
    category: str  # output_format, logic_error, wrong_data, wrong_approach, tone, scope, other
    severity: str  # minor, moderate, major, critical
    applied: bool = False
    created_at: str
    tags: list[str] = []


class CorrectionTracker:
    """Captures, stores, and retrieves user corrections."""

    def __init__(
        self,
        supabase: "SupabaseManager",
        llm: "OpenRouterClient",
        company_id: str,
    ) -> None:
        self._sb = supabase
        self._llm = llm
        self._company_id = company_id

    # ------------------------------------------------------------------
    # Record
    # ------------------------------------------------------------------

    async def record_correction(
        self,
        agent_name: str,
        original_action: str,
        correction_text: str,
    ) -> Correction:
        """Parse a user correction and store it."""
        analysis = await self._llm.think_structured(
            "You analyse corrections that users make to AI agents. "
            "Extract structured information from the correction.",
            f"A user corrected an AI agent.\n\n"
            f"Agent: {agent_name}\n"
            f"Original action: {original_action}\n"
            f"User's correction: {correction_text}\n\n"
            f"Determine:\n"
            f"- corrected_action: what should have been done instead (one sentence)\n"
            f"- category: one of output_format, logic_error, wrong_data, wrong_approach, tone, scope, other\n"
            f"- severity: minor, moderate, major, or critical\n"
            f"- tags: 3-5 keyword tags for this correction",
            {
                "type": "object",
                "properties": {
                    "corrected_action": {"type": "string"},
                    "category": {"type": "string"},
                    "severity": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
            },
        )

        is_dict = isinstance(analysis, dict)

        correction = Correction(
            correction_id=str(uuid.uuid4())[:8],
            company_id=self._company_id,
            agent_name=agent_name,
            original_action=original_action,
            correction_text=correction_text,
            corrected_action=analysis.get("corrected_action", correction_text) if is_dict else correction_text,
            category=analysis.get("category", "other") if is_dict else "other",
            severity=analysis.get("severity", "moderate") if is_dict else "moderate",
            created_at=datetime.now(timezone.utc).isoformat(),
            tags=analysis.get("tags", []) if is_dict else [],
        )

        self._sb.log_correction(self._company_id, correction.model_dump())

        return correction

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    async def get_corrections_for_agent(self, agent_name: str) -> list[dict]:
        """Get all unapplied corrections for a specific agent."""
        all_corrections = self._sb.get_unapplied_corrections(self._company_id) or []
        return [c for c in all_corrections if c.get("agent_name") == agent_name]

    async def get_all_corrections(self) -> list[dict]:
        """Get all unapplied corrections for this company."""
        return self._sb.get_unapplied_corrections(self._company_id) or []

    # ------------------------------------------------------------------
    # Mark applied
    # ------------------------------------------------------------------

    async def mark_applied(self, correction_id: str) -> None:
        """Mark a correction as applied (incorporated into agent behaviour)."""
        self._sb.mark_correction_applied(correction_id)

    # ------------------------------------------------------------------
    # Pattern detection
    # ------------------------------------------------------------------

    async def find_patterns(self) -> list[dict]:
        """Identify repeated correction patterns using LLM."""
        all_corrections = await self.get_all_corrections()

        if len(all_corrections) < 3:
            return []

        corrections_summary = "\n".join(
            f"- Agent: {c.get('agent_name')}, Category: {c.get('category')}, "
            f"Correction: {c.get('correction_text', '')[:100]}"
            for c in all_corrections[:20]
        )

        result = await self._llm.think_structured(
            "You analyse patterns in corrections made to an AI agent system.",
            f"Analyse these corrections and identify repeated patterns:\n\n"
            f"{corrections_summary}\n\n"
            f"For each pattern provide:\n"
            f"- pattern: description of the recurring issue\n"
            f"- frequency: how many corrections match this pattern\n"
            f"- affected_agents: which agents are affected\n"
            f"- suggested_fix: systemic fix to prevent recurrence",
            {
                "type": "object",
                "properties": {
                    "patterns": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "pattern": {"type": "string"},
                                "frequency": {"type": "integer"},
                                "affected_agents": {"type": "array", "items": {"type": "string"}},
                                "suggested_fix": {"type": "string"},
                            },
                        },
                    },
                },
            },
        )

        return result.get("patterns", []) if isinstance(result, dict) else []

    # ------------------------------------------------------------------
    # Context builder
    # ------------------------------------------------------------------

    def build_correction_context(self, corrections: list[dict]) -> str:
        """Build a context string from corrections for injection into agent prompts."""
        if not corrections:
            return ""

        lines = ["IMPORTANT — Past corrections to remember:"]
        for c in corrections[:10]:
            lines.append(
                f"- When doing '{c.get('category', 'task')}' tasks: "
                f"{c.get('corrected_action', c.get('correction_text', ''))}"
            )
        return "\n".join(lines)
