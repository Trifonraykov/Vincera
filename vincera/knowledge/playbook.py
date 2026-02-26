"""Playbook manager: persistent agent memory of what worked and what didn't."""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vincera.core.llm import OpenRouterClient
    from vincera.knowledge.supabase_client import SupabaseManager

logger = logging.getLogger(__name__)

_STOPWORDS = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "and", "but", "or",
    "not", "no", "if", "then", "than", "that", "this", "it", "its",
})


class PlaybookManager:
    """Manages agent playbook entries — persistent memory of approaches and outcomes."""

    def __init__(
        self,
        supabase_manager: "SupabaseManager",
        llm: "OpenRouterClient",
    ) -> None:
        self._sb = supabase_manager
        self._llm = llm

    async def consult(
        self,
        company_id: str,
        agent_name: str,
        task_description: str,
        limit: int = 5,
    ) -> list[dict]:
        """Find relevant playbook entries for a task.

        1. Extract semantic tags from the task description.
        2. Query Supabase playbook entries.
        3. Sort: success first, then most recent.
        4. Return top `limit` entries.
        """
        tags = await self.extract_tags(task_description)

        # Over-fetch to allow client-side sorting
        entries = self._sb.query_playbook(
            company_id=company_id,
            agent_name=agent_name,
            tags=tags,
            limit=limit * 3,
        )

        # Sort: success first, then most recent (assuming newer entries are later in list)
        entries.sort(key=lambda e: (not e.get("success", False),))

        return entries[:limit]

    async def record(
        self,
        company_id: str,
        agent_name: str,
        action_type: str,
        context_summary: str,
        approach: str,
        outcome: str,
        success: bool,
        lessons_learned: str,
    ) -> dict | None:
        """Record a new playbook entry."""
        tags = await self.extract_tags(context_summary)

        entry = {
            "action_type": action_type,
            "context_summary": context_summary,
            "approach": approach,
            "outcome": outcome,
            "success": success,
            "lessons_learned": lessons_learned,
            "similarity_tags": tags,
        }

        return self._sb.add_playbook_entry(
            company_id=company_id,
            agent_name=agent_name,
            entry=entry,
        )

    async def extract_tags(self, text: str) -> list[str]:
        """Extract 3-8 semantic tags from text using LLM, with keyword fallback."""
        try:
            result = await self._llm.think_structured(
                system_prompt=(
                    "Extract 3-8 semantic tags from the given text. "
                    "Tags should capture the key concepts, actions, and domains. "
                    "Return lowercase, underscore-separated tags."
                ),
                user_message=text,
                response_schema={
                    "type": "object",
                    "properties": {
                        "tags": {
                            "type": "array",
                            "items": {"type": "string"},
                            "minItems": 3,
                            "maxItems": 8,
                        }
                    },
                    "required": ["tags"],
                },
            )
            tags = result.get("tags", [])
            if tags and len(tags) >= 3:
                return tags[:8]
        except Exception as exc:
            logger.warning("LLM tag extraction failed, using fallback: %s", exc)

        # Fallback: simple keyword extraction
        return _extract_keywords(text)


def _extract_keywords(text: str, limit: int = 5) -> list[str]:
    """Simple keyword extraction: split, remove stopwords, take top words."""
    words = re.findall(r"[a-z_]+", text.lower())
    seen: set[str] = set()
    keywords: list[str] = []
    for word in words:
        if word not in _STOPWORDS and len(word) > 2 and word not in seen:
            seen.add(word)
            keywords.append(word)
            if len(keywords) >= limit:
                break
    return keywords
