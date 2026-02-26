"""Business researcher: identifies topics and finds academic/industry sources."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vincera.core.llm import OpenRouterClient
    from vincera.discovery.company_model import CompanyModel

logger = logging.getLogger(__name__)

_TOPICS_SCHEMA = {
    "type": "object",
    "properties": {
        "topics": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string"},
                    "relevance": {"type": "string"},
                },
                "required": ["topic", "relevance"],
            },
            "minItems": 5,
            "maxItems": 10,
        },
    },
    "required": ["topics"],
}

_SOURCES_SCHEMA = {
    "type": "object",
    "properties": {
        "sources": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "authors": {"type": "string"},
                    "publication": {"type": "string"},
                    "year": {"type": "integer"},
                    "source_type": {"type": "string"},
                    "summary": {"type": "string"},
                    "url": {"type": "string"},
                },
                "required": ["title", "summary", "source_type"],
            },
        },
    },
    "required": ["sources"],
}


class BusinessResearcher:
    """Identifies research topics and finds academic/industry sources."""

    def __init__(self, llm: "OpenRouterClient") -> None:
        self._llm = llm

    async def identify_topics(self, company_model: "CompanyModel") -> list[dict]:
        """Generate 5–10 research topics specific to this business."""
        pain_points = ", ".join(company_model.pain_points) if company_model.pain_points else "none identified"
        opportunities = ", ".join(
            o.get("name", "") for o in company_model.automation_opportunities[:5]
        ) if company_model.automation_opportunities else "none identified"

        user_message = (
            f"Business type: {company_model.business_type}\n"
            f"Industry: {company_model.industry}\n"
            f"Pain points: {pain_points}\n"
            f"Automation opportunities: {opportunities}\n"
            f"Key findings: {', '.join(company_model.key_findings[:5])}"
        )

        try:
            result = await self._llm.think_structured(
                system_prompt=(
                    "Generate 5-10 specific research topics for this business. Each topic should be "
                    "specific enough to find real academic papers, industry reports, or recognized "
                    "business studies. Focus on topics that address the company's pain points and "
                    "automation opportunities. Do not generate generic topics."
                ),
                user_message=user_message,
                response_schema=_TOPICS_SCHEMA,
            )
            return result.get("topics", [])
        except Exception as exc:
            logger.error("Failed to identify research topics: %s", exc)
            return [{"topic": f"{company_model.business_type} operations best practices", "relevance": "fallback"}]

    async def research_topic(self, topic: str) -> list[dict]:
        """Research a single topic and return structured source list."""
        query = (
            f"Find 3-5 well-regarded academic papers, industry reports, or recognized business "
            f"studies about: {topic}. For each source, provide: title, authors (if known), "
            f"publication or publisher, year, source_type (academic_paper, industry_report, "
            f"case_study, best_practice_guide), a 2-3 sentence summary of key findings, and a "
            f"URL if known. Only cite sources you are confident are real. Do not invent sources."
        )

        try:
            raw_text = await self._llm.research(query=query)
        except Exception as exc:
            logger.warning("Research call failed for topic '%s': %s", topic, exc)
            return []

        try:
            result = await self._llm.think_structured(
                system_prompt=(
                    "Parse the following research results into a structured list of sources. "
                    "Extract title, authors, publication, year, source_type, summary, and url "
                    "for each source found. If information is missing, omit it."
                ),
                user_message=raw_text,
                response_schema=_SOURCES_SCHEMA,
            )
            sources = result.get("sources", [])
            for s in sources:
                s["topic"] = topic
            return sources
        except Exception as exc:
            logger.error("Failed to parse research results for '%s': %s", topic, exc)
            return []

    async def run_full_research(self, company_model: "CompanyModel") -> list[dict]:
        """Research all topics and return deduplicated sources."""
        topics = await self.identify_topics(company_model)

        all_sources: list[dict] = []
        for topic_dict in topics:
            topic_str = topic_dict.get("topic", "") if isinstance(topic_dict, dict) else str(topic_dict)
            sources = await self.research_topic(topic_str)
            all_sources.extend(sources)

        return self._deduplicate(all_sources)

    @staticmethod
    def _deduplicate(sources: list[dict]) -> list[dict]:
        """Deduplicate sources by title (case-insensitive, stripped)."""
        seen: set[str] = set()
        unique: list[dict] = []
        for s in sources:
            key = s.get("title", "").strip().lower()
            if key and key not in seen:
                seen.add(key)
                unique.append(s)
        return unique
