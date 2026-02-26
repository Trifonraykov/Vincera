"""Research Agent: autonomous research on business operations best practices."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from vincera.agents.base import BaseAgent

if TYPE_CHECKING:
    from vincera.config import VinceraSettings
    from vincera.core.llm import OpenRouterClient
    from vincera.core.state import GlobalState
    from vincera.discovery.company_model import CompanyModel
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.research.knowledge_extractor import KnowledgeExtractor
    from vincera.research.researcher import BusinessResearcher
    from vincera.research.source_validator import SourceValidator
    from vincera.verification.verifier import Verifier

logger = logging.getLogger(__name__)


class ResearchAgent(BaseAgent):
    """Researches how this type of business operates optimally."""

    def __init__(
        self,
        name: str,
        company_id: str,
        config: "VinceraSettings",
        llm: "OpenRouterClient",
        supabase: "SupabaseManager",
        state: "GlobalState",
        verifier: "Verifier",
        researcher: "BusinessResearcher",
        validator: "SourceValidator",
        extractor: "KnowledgeExtractor",
    ) -> None:
        super().__init__(name, company_id, config, llm, supabase, state, verifier)
        self._researcher = researcher
        self._validator = validator
        self._extractor = extractor

    async def run(self, task: dict) -> dict:
        """Run business research pipeline."""
        company_model: CompanyModel = task.get("company_model")
        if company_model is None:
            await self.send_message(
                "No company model provided. Run discovery first.",
                message_type="error",
            )
            return {"status": "error", "reason": "no_company_model"}

        # Phase 1: Identify topics
        await self.send_message(
            f"I'm going to research how {company_model.business_type} businesses in the "
            f"{company_model.industry} industry optimize their operations. "
            f"Finding relevant studies now...",
            message_type="chat",
        )
        topics = await self._researcher.identify_topics(company_model)
        topic_names = [t["topic"] for t in topics[:5]] if topics else []
        suffix = "..." if len(topics) > 5 else ""
        await self.send_message(
            f"Identified {len(topics)} research topics: {', '.join(topic_names)}{suffix}",
            message_type="chat",
        )

        # Phase 2: Research all topics
        all_sources = await self._researcher.run_full_research(company_model)
        await self.send_message(
            f"Found {len(all_sources)} potential sources across all topics.",
            message_type="chat",
        )

        # Phase 3: Validate sources
        validated = [self._validator.validate(s) for s in all_sources]
        quality_sources = self._validator.filter_quality(validated)
        rejected_count = len(validated) - len(quality_sources)
        await self.send_message(
            f"After quality filtering: {len(quality_sources)} credible sources accepted, "
            f"{rejected_count} rejected (blogs, unverified, or low-quality).",
            message_type="chat",
        )

        # Phase 4: Extract insights
        all_insights: list[dict] = []
        for source in quality_sources:
            # Save source to Supabase
            self._sb.add_research_source(self._company_id, {
                "title": source.get("title"),
                "authors": source.get("authors"),
                "source_type": source.get("source_type"),
                "url": source.get("url"),
                "publication": source.get("publication"),
                "year": source.get("year"),
                "relevance_score": source.get("relevance_score", 0.8),
                "quality_score": source.get("quality_score"),
                "summary": source.get("summary"),
                "key_insights": [],
                "applicable_processes": [],
            })

            insights = await self._extractor.extract_insights(source, company_model)
            for insight in insights:
                self._sb.add_research_insight(self._company_id, {
                    "insight": insight.get("insight"),
                    "category": insight.get("category"),
                    "actionability": insight.get("actionability"),
                    "applied": False,
                })
            all_insights.extend(insights)

        # Phase 5: Narrate key findings
        immediately_actionable = [
            i for i in all_insights if i.get("actionability") == "immediately_actionable"
        ]

        narration_parts = [
            f"I've finished researching how {company_model.business_type} businesses "
            f"optimize their operations.",
            f"Studied {len(quality_sources)} credible sources. "
            f"Extracted {len(all_insights)} insights.",
        ]
        if immediately_actionable:
            narration_parts.append("\nTop actionable findings:")
            for i, insight in enumerate(immediately_actionable[:5], 1):
                narration_parts.append(f"{i}. {insight.get('insight', '')}")
        narration_parts.append(
            "\nI'll use these insights to prioritize which automations to build first."
        )
        await self.send_message("\n".join(narration_parts), message_type="chat")

        # Phase 6: Record to playbook
        top_categories = ", ".join(set(i.get("category", "") for i in all_insights[:10]))
        await self.record_to_playbook(
            action_type="business_research",
            context=f"Research on {company_model.business_type} in {company_model.industry}",
            approach=f"Researched {len(topics)} topics",
            outcome=f"Found {len(quality_sources)} sources, {len(all_insights)} insights",
            success=True,
            lessons=f"Top categories: {top_categories}" if top_categories else "No insights extracted",
        )

        return {
            "status": "complete",
            "sources_found": len(quality_sources),
            "sources_rejected": rejected_count,
            "insights_extracted": len(all_insights),
            "immediately_actionable": len(immediately_actionable),
        }
