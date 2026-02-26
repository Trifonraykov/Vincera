"""Tests for Stage 8 — Research Agent."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from vincera.discovery.company_model import CompanyModel
from vincera.research.researcher import BusinessResearcher
from vincera.research.source_validator import SourceValidator
from vincera.research.knowledge_extractor import KnowledgeExtractor


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    """Run an async coroutine synchronously."""
    return asyncio.run(coro)


def _sample_company_model() -> CompanyModel:
    return CompanyModel(
        business_type="ecommerce",
        industry="retail",
        confidence=0.85,
        software_stack=[{"name": "Shopify", "category": "ecommerce_platform", "role": "storefront"}],
        data_architecture=[],
        detected_processes=[{"name": "manual invoicing", "manual": True, "frequency": "daily", "evidence": "spreadsheet"}],
        automation_opportunities=[{"name": "invoice automation", "description": "auto-generate invoices"}],
        pain_points=["manual invoicing", "inventory tracking delays"],
        risk_areas=[],
        key_findings=["Uses Shopify for storefront"],
    )


def _mock_llm():
    llm = MagicMock()
    llm.think = AsyncMock(return_value="Some response")
    llm.think_structured = AsyncMock(return_value={})
    llm.research = AsyncMock(return_value="Here are some sources about ecommerce operations...")
    return llm


def _mock_supabase():
    sb = MagicMock()
    sb.send_message.return_value = {"id": "msg-1"}
    sb.add_research_source.return_value = {"id": "rs-1"}
    sb.add_research_insight.return_value = {"id": "ri-1"}
    sb.add_knowledge.return_value = {"id": "k-1"}
    sb.add_playbook_entry.return_value = {"id": "pb-1"}
    sb.query_playbook.return_value = []
    sb.query_knowledge.return_value = []
    sb.get_research_library.return_value = []
    sb.create_decision.return_value = "dec-1"
    return sb


def _mock_state():
    state = MagicMock()
    state.add_action = MagicMock()
    state.update_agent_status = MagicMock()
    state.get_agent_status.return_value = {"agent_name": "research", "status": "idle", "current_task": "none"}
    state._db = MagicMock()
    state._db.query.return_value = []
    return state


def _mock_verifier():
    from vincera.verification.verifier import CheckResult, VerificationResult
    v = MagicMock()
    v.verify = AsyncMock(return_value=VerificationResult(
        passed=True, checks=[CheckResult(name="test", passed=True, reason="ok")],
        confidence=0.95, blocked_reason=None,
    ))
    return v


def _mock_config(tmp_path: Path):
    config = MagicMock()
    config.home_dir = tmp_path / "vincera"
    config.home_dir.mkdir(parents=True, exist_ok=True)
    config.company_name = "TestCo"
    return config


def _good_source(title="Ecommerce Operations Best Practices", **overrides):
    base = {
        "title": title,
        "authors": "Smith, J.",
        "publication": "Harvard Business Review",
        "year": 2022,
        "source_type": "industry_report",
        "summary": "A comprehensive study of ecommerce operations.",
        "url": "https://hbr.org/2022/ecommerce",
        "topic": "ecommerce operations",
    }
    base.update(overrides)
    return base


def _bad_source(**overrides):
    base = {
        "title": "10 Tips for Your Online Store",
        "authors": None,
        "publication": "RandomBlog.com",
        "year": None,
        "source_type": "blog",
        "summary": "A blog about selling stuff online.",
        "url": "https://randomblog.com/tips",
        "topic": "ecommerce operations",
    }
    base.update(overrides)
    return base


# ===========================================================================
# BusinessResearcher tests
# ===========================================================================

class TestIdentifyTopics:
    def test_returns_list(self):
        llm = _mock_llm()
        llm.think_structured.return_value = {
            "topics": [
                {"topic": "ecommerce automation", "relevance": "core operations"},
                {"topic": "invoice processing optimization", "relevance": "pain point"},
                {"topic": "inventory management systems", "relevance": "detected process"},
                {"topic": "order fulfillment efficiency", "relevance": "operational"},
                {"topic": "retail financial reconciliation", "relevance": "finance"},
            ]
        }
        researcher = BusinessResearcher(llm)
        topics = _run(researcher.identify_topics(_sample_company_model()))
        assert isinstance(topics, list)
        assert len(topics) >= 5
        assert all("topic" in t for t in topics)

    def test_uses_company_model(self):
        llm = _mock_llm()
        llm.think_structured.return_value = {
            "topics": [{"topic": "test", "relevance": "test"}] * 5
        }
        researcher = BusinessResearcher(llm)
        model = _sample_company_model()
        _run(researcher.identify_topics(model))

        call_args = llm.think_structured.call_args
        user_msg = call_args.kwargs.get("user_message", call_args.args[1] if len(call_args.args) > 1 else "")
        assert "ecommerce" in user_msg.lower()


class TestResearchTopic:
    def test_returns_sources(self):
        llm = _mock_llm()
        llm.research.return_value = "Found several studies on ecommerce..."
        llm.think_structured.return_value = {
            "sources": [
                {
                    "title": "Ecommerce Operations Study",
                    "authors": "Doe, J.",
                    "publication": "MIT Sloan Management Review",
                    "year": 2021,
                    "source_type": "academic_paper",
                    "summary": "Study of ecommerce operations.",
                    "url": "https://example.com/study",
                },
            ]
        }
        researcher = BusinessResearcher(llm)
        sources = _run(researcher.research_topic("ecommerce operations"))
        assert isinstance(sources, list)
        assert len(sources) >= 1
        assert "title" in sources[0]
        assert "summary" in sources[0]
        assert "source_type" in sources[0]
        assert sources[0]["topic"] == "ecommerce operations"

    def test_deduplicates(self):
        llm = _mock_llm()
        llm.think_structured.side_effect = [
            # identify_topics
            {"topics": [
                {"topic": "topic_a", "relevance": "r"},
                {"topic": "topic_b", "relevance": "r"},
            ]},
            # research_topic("topic_a") parse
            {"sources": [{"title": "Same Study", "authors": "A", "publication": "P", "year": 2022,
                          "source_type": "academic_paper", "summary": "s", "url": None}]},
            # research_topic("topic_b") parse
            {"sources": [{"title": "  same study  ", "authors": "A", "publication": "P", "year": 2022,
                          "source_type": "academic_paper", "summary": "s", "url": None}]},
        ]
        researcher = BusinessResearcher(llm)
        all_sources = _run(researcher.run_full_research(_sample_company_model()))
        assert len(all_sources) == 1


# ===========================================================================
# SourceValidator tests
# ===========================================================================

class TestSourceValidator:
    def test_accepts_hbr(self):
        v = SourceValidator()
        result = v.validate(_good_source(publication="Harvard Business Review"))
        assert result["quality_score"] >= 0.7

    def test_accepts_mckinsey(self):
        v = SourceValidator()
        result = v.validate(_good_source(publication="McKinsey Global Institute"))
        assert result["quality_score"] >= 0.7

    def test_accepts_academic(self):
        v = SourceValidator()
        result = v.validate(_good_source(publication="IEEE Transactions", source_type="academic_paper"))
        assert result["quality_score"] >= 0.7

    def test_rejects_blog(self):
        v = SourceValidator()
        result = v.validate(_bad_source(source_type="blog"))
        assert result["quality_score"] < 0.7

    def test_rejects_forum(self):
        v = SourceValidator()
        result = v.validate(_bad_source(source_type="forum"))
        assert result["quality_score"] < 0.7

    def test_rejects_no_author_no_year(self):
        v = SourceValidator()
        result = v.validate(_good_source(
            authors=None, year=None, publication="Unknown Publisher"
        ))
        assert result["quality_score"] < 0.7

    def test_filter_quality(self):
        v = SourceValidator()
        sources = [
            v.validate(_good_source(title="Good Study")),
            v.validate(_bad_source(title="Bad Blog")),
            v.validate(_good_source(title="Another Good", publication="McKinsey")),
        ]
        filtered = v.filter_quality(sources)
        good_titles = {s["title"] for s in filtered}
        assert "Good Study" in good_titles
        assert "Another Good" in good_titles
        assert "Bad Blog" not in good_titles


# ===========================================================================
# KnowledgeExtractor tests
# ===========================================================================

class TestKnowledgeExtractor:
    def test_returns_insights(self):
        llm = _mock_llm()
        llm.think_structured.return_value = {
            "insights": [
                {
                    "insight": "Automating invoice generation reduces errors by 80%",
                    "category": "finance",
                    "actionability": "immediately_actionable",
                    "how_to_apply": "Integrate invoice API with Shopify orders",
                },
                {
                    "insight": "Real-time inventory sync prevents overselling",
                    "category": "operations",
                    "actionability": "strategic",
                    "how_to_apply": "Connect inventory system to storefront",
                },
            ]
        }
        extractor = KnowledgeExtractor(llm)
        insights = _run(extractor.extract_insights(
            _good_source(), _sample_company_model()
        ))
        assert isinstance(insights, list)
        assert len(insights) == 2
        assert "insight" in insights[0]
        assert "category" in insights[0]
        assert "actionability" in insights[0]

    def test_insights_reference_company(self):
        llm = _mock_llm()
        llm.think_structured.return_value = {
            "insights": [{"insight": "x", "category": "ops", "actionability": "strategic", "how_to_apply": "y"}]
        }
        extractor = KnowledgeExtractor(llm)
        model = _sample_company_model()
        _run(extractor.extract_insights(_good_source(), model))

        call_args = llm.think_structured.call_args
        user_msg = call_args.kwargs.get("user_message", call_args.args[1] if len(call_args.args) > 1 else "")
        assert "manual invoicing" in user_msg.lower()


# ===========================================================================
# ResearchAgent tests
# ===========================================================================

class TestResearchAgent:
    def test_full_run(self, tmp_path):
        from vincera.agents.research import ResearchAgent

        llm = _mock_llm()
        sb = _mock_supabase()
        state = _mock_state()
        config = _mock_config(tmp_path)
        verifier = _mock_verifier()

        researcher = MagicMock()
        researcher.identify_topics = AsyncMock(return_value=[
            {"topic": "ecommerce automation", "relevance": "core"},
            {"topic": "invoice processing", "relevance": "pain point"},
        ])
        researcher.run_full_research = AsyncMock(return_value=[
            _good_source(title="Study A"),
            _good_source(title="Study B"),
        ])

        validator = MagicMock()
        validated_a = {**_good_source(title="Study A"), "quality_score": 0.9, "validation_reason": "trusted"}
        validated_b = {**_good_source(title="Study B"), "quality_score": 0.85, "validation_reason": "trusted"}
        validator.validate.side_effect = [validated_a, validated_b]
        validator.filter_quality.return_value = [validated_a, validated_b]

        extractor = MagicMock()
        extractor.extract_insights = AsyncMock(return_value=[
            {"insight": "Automate invoicing", "category": "finance",
             "actionability": "immediately_actionable", "how_to_apply": "Use API",
             "source_title": "Study A"},
        ])

        agent = ResearchAgent(
            name="research",
            company_id="comp-123",
            config=config,
            llm=llm,
            supabase=sb,
            state=state,
            verifier=verifier,
            researcher=researcher,
            validator=validator,
            extractor=extractor,
        )

        model = _sample_company_model()
        result = _run(agent.run({"company_model": model}))

        # At least 4 narration messages
        assert sb.send_message.call_count >= 4

        # Sources saved to Supabase
        assert sb.add_research_source.call_count == 2

        # Insights saved to Supabase
        assert sb.add_research_insight.call_count >= 2  # 1 per source

        # Playbook recorded
        assert sb.add_playbook_entry.call_count >= 1

        # Return dict structure
        assert result["status"] == "complete"
        assert "sources_found" in result
        assert "insights_extracted" in result

    def test_handles_no_sources(self, tmp_path):
        from vincera.agents.research import ResearchAgent

        llm = _mock_llm()
        sb = _mock_supabase()
        state = _mock_state()
        config = _mock_config(tmp_path)
        verifier = _mock_verifier()

        researcher = MagicMock()
        researcher.identify_topics = AsyncMock(return_value=[
            {"topic": "niche topic", "relevance": "exploratory"},
        ])
        researcher.run_full_research = AsyncMock(return_value=[])

        validator = MagicMock()
        validator.filter_quality.return_value = []

        extractor = MagicMock()
        extractor.extract_insights = AsyncMock(return_value=[])

        agent = ResearchAgent(
            name="research",
            company_id="comp-123",
            config=config,
            llm=llm,
            supabase=sb,
            state=state,
            verifier=verifier,
            researcher=researcher,
            validator=validator,
            extractor=extractor,
        )

        result = _run(agent.run({"company_model": _sample_company_model()}))
        assert result["status"] == "complete"
        assert result["sources_found"] == 0

    def test_handles_all_rejected(self, tmp_path):
        from vincera.agents.research import ResearchAgent

        llm = _mock_llm()
        sb = _mock_supabase()
        state = _mock_state()
        config = _mock_config(tmp_path)
        verifier = _mock_verifier()

        researcher = MagicMock()
        researcher.identify_topics = AsyncMock(return_value=[
            {"topic": "topic a", "relevance": "r"},
        ])
        researcher.run_full_research = AsyncMock(return_value=[
            _bad_source(title="Blog Post 1"),
            _bad_source(title="Blog Post 2"),
        ])

        validator = MagicMock()
        rejected_a = {**_bad_source(title="Blog Post 1"), "quality_score": 0.2, "validation_reason": "blog"}
        rejected_b = {**_bad_source(title="Blog Post 2"), "quality_score": 0.1, "validation_reason": "blog"}
        validator.validate.side_effect = [rejected_a, rejected_b]
        validator.filter_quality.return_value = []  # all rejected

        extractor = MagicMock()
        extractor.extract_insights = AsyncMock(return_value=[])

        agent = ResearchAgent(
            name="research",
            company_id="comp-123",
            config=config,
            llm=llm,
            supabase=sb,
            state=state,
            verifier=verifier,
            researcher=researcher,
            validator=validator,
            extractor=extractor,
        )

        result = _run(agent.run({"company_model": _sample_company_model()}))
        assert result["status"] == "complete"
        assert result["sources_found"] == 0
        assert result["sources_rejected"] == 2
        # Should still send message about 0 accepted
        narration_calls = [
            c for c in sb.send_message.call_args_list
            if "0" in str(c) or "rejected" in str(c).lower() or "accepted" in str(c).lower()
        ]
        assert len(narration_calls) >= 1
