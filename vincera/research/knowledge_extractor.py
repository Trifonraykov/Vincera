"""Knowledge extractor: extracts actionable insights from research sources."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vincera.core.llm import OpenRouterClient
    from vincera.discovery.company_model import CompanyModel

logger = logging.getLogger(__name__)

_INSIGHTS_SCHEMA = {
    "type": "object",
    "properties": {
        "insights": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "insight": {"type": "string"},
                    "category": {"type": "string"},
                    "actionability": {"type": "string"},
                    "how_to_apply": {"type": "string"},
                },
                "required": ["insight", "category", "actionability", "how_to_apply"],
            },
            "minItems": 1,
            "maxItems": 5,
        },
    },
    "required": ["insights"],
}


class KnowledgeExtractor:
    """Extracts actionable insights from research sources for a specific company."""

    def __init__(self, llm: "OpenRouterClient") -> None:
        self._llm = llm

    async def extract_insights(
        self,
        source: dict,
        company_model: "CompanyModel",
    ) -> list[dict]:
        """Extract 2–5 actionable insights from a source for this company."""
        pain_points = ", ".join(company_model.pain_points) if company_model.pain_points else "none identified"

        user_message = (
            f"Given this research source about {source.get('topic', 'business operations')}:\n"
            f"Title: {source.get('title', 'Unknown')}\n"
            f"Summary: {source.get('summary', 'No summary available')}\n\n"
            f"And this company profile:\n"
            f"Business type: {company_model.business_type}\n"
            f"Industry: {company_model.industry}\n"
            f"Key pain points: {pain_points}\n\n"
            f"Extract 2-5 specific, actionable insights that apply to THIS company. "
            f"For each insight provide:\n"
            f"- insight: the specific finding or recommendation\n"
            f"- category: which business domain (operations, finance, hr, sales, supply_chain, "
            f"customer_service, marketing, compliance, it)\n"
            f"- actionability: 'immediately_actionable', 'strategic', or 'informational'\n"
            f"- how_to_apply: one sentence on how this company could apply this"
        )

        try:
            result = await self._llm.think_structured(
                system_prompt=(
                    "You are extracting actionable business insights from research for a specific "
                    "company. Only include insights that are directly relevant to this company's "
                    "situation. Be specific and practical."
                ),
                user_message=user_message,
                response_schema=_INSIGHTS_SCHEMA,
            )
            insights = result.get("insights", [])
            for insight in insights:
                insight["source_title"] = source.get("title", "Unknown")
            return insights
        except Exception as exc:
            logger.error("Failed to extract insights from '%s': %s", source.get("title"), exc)
            return []
