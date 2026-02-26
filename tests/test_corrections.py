"""Tests for vincera.training.corrections — CorrectionTracker."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from vincera.training.corrections import Correction, CorrectionTracker


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _mock_llm(analysis: dict | None = None):
    llm = MagicMock()
    llm.think_structured = AsyncMock(return_value=analysis or {
        "corrected_action": "Use bullet points instead of paragraphs",
        "category": "output_format",
        "severity": "moderate",
        "tags": ["formatting", "output", "bullets"],
    })
    return llm


def _mock_supabase(corrections: list | None = None):
    sb = MagicMock()
    sb.log_correction.return_value = {"id": "corr-1"}
    sb.get_unapplied_corrections.return_value = corrections or []
    sb.mark_correction_applied.return_value = {"id": "corr-1"}
    return sb


def _build_tracker(llm=None, supabase=None, company_id="comp-1"):
    return CorrectionTracker(
        supabase=supabase or _mock_supabase(),
        llm=llm or _mock_llm(),
        company_id=company_id,
    )


# ===========================================================================
# record_correction
# ===========================================================================

class TestRecordCorrection:
    def test_creates_correction(self) -> None:
        tracker = _build_tracker()
        result = _run(tracker.record_correction(
            agent_name="builder",
            original_action="Wrote a paragraph summary",
            correction_text="Use bullet points, not paragraphs",
        ))
        assert isinstance(result, Correction)
        assert result.agent_name == "builder"
        assert result.original_action == "Wrote a paragraph summary"
        assert result.correction_text == "Use bullet points, not paragraphs"
        assert result.corrected_action == "Use bullet points instead of paragraphs"
        assert result.category == "output_format"
        assert result.severity == "moderate"
        assert result.company_id == "comp-1"
        assert len(result.correction_id) == 8
        assert result.applied is False

    def test_saves_to_supabase(self) -> None:
        sb = _mock_supabase()
        tracker = _build_tracker(supabase=sb)
        _run(tracker.record_correction("builder", "did X", "do Y instead"))
        sb.log_correction.assert_called_once()
        args = sb.log_correction.call_args
        assert args[0][0] == "comp-1"
        assert isinstance(args[0][1], dict)
        assert args[0][1]["agent_name"] == "builder"

    def test_llm_prompt_contains_context(self) -> None:
        llm = _mock_llm()
        tracker = _build_tracker(llm=llm)
        _run(tracker.record_correction("analyst", "Generated wrong chart", "Use bar chart"))
        call_args = llm.think_structured.call_args
        # user_message is the second positional arg
        user_msg = call_args[0][1]
        assert "analyst" in user_msg
        assert "Generated wrong chart" in user_msg
        assert "Use bar chart" in user_msg

    def test_handles_llm_failure(self) -> None:
        llm = _mock_llm()
        llm.think_structured = AsyncMock(return_value="not a dict")
        tracker = _build_tracker(llm=llm)
        result = _run(tracker.record_correction("builder", "did X", "do Y"))
        assert result.category == "other"
        assert result.severity == "moderate"
        assert result.corrected_action == "do Y"
        assert result.tags == []


# ===========================================================================
# get_corrections_for_agent
# ===========================================================================

class TestGetCorrectionsForAgent:
    def test_filters_by_agent(self) -> None:
        corrections = [
            {"agent_name": "builder", "correction_text": "fix 1"},
            {"agent_name": "analyst", "correction_text": "fix 2"},
            {"agent_name": "builder", "correction_text": "fix 3"},
        ]
        sb = _mock_supabase(corrections=corrections)
        tracker = _build_tracker(supabase=sb)
        result = _run(tracker.get_corrections_for_agent("builder"))
        assert len(result) == 2
        assert all(c["agent_name"] == "builder" for c in result)


# ===========================================================================
# get_all_corrections
# ===========================================================================

class TestGetAllCorrections:
    def test_returns_list(self) -> None:
        corrections = [{"agent_name": "a"}, {"agent_name": "b"}]
        sb = _mock_supabase(corrections=corrections)
        tracker = _build_tracker(supabase=sb)
        result = _run(tracker.get_all_corrections())
        assert len(result) == 2


# ===========================================================================
# mark_applied
# ===========================================================================

class TestMarkApplied:
    def test_calls_supabase(self) -> None:
        sb = _mock_supabase()
        tracker = _build_tracker(supabase=sb)
        _run(tracker.mark_applied("corr-42"))
        sb.mark_correction_applied.assert_called_once_with("corr-42")


# ===========================================================================
# find_patterns
# ===========================================================================

class TestFindPatterns:
    def test_enough_data(self) -> None:
        corrections = [
            {"agent_name": "builder", "category": "output_format", "correction_text": "fix 1"},
            {"agent_name": "builder", "category": "output_format", "correction_text": "fix 2"},
            {"agent_name": "analyst", "category": "logic_error", "correction_text": "fix 3"},
            {"agent_name": "operator", "category": "wrong_data", "correction_text": "fix 4"},
            {"agent_name": "builder", "category": "output_format", "correction_text": "fix 5"},
        ]
        sb = _mock_supabase(corrections=corrections)
        llm = _mock_llm()
        llm.think_structured = AsyncMock(side_effect=[
            # First call is from record_correction (not used here),
            # but find_patterns calls think_structured directly
            {"patterns": [
                {
                    "pattern": "Builder agent repeatedly uses wrong output format",
                    "frequency": 3,
                    "affected_agents": ["builder"],
                    "suggested_fix": "Add output format instructions to builder prompt",
                },
            ]},
        ])
        tracker = _build_tracker(llm=llm, supabase=sb)
        result = _run(tracker.find_patterns())
        assert len(result) == 1
        assert result[0]["pattern"] == "Builder agent repeatedly uses wrong output format"
        llm.think_structured.assert_called_once()

    def test_not_enough_data(self) -> None:
        corrections = [
            {"agent_name": "builder", "category": "output_format", "correction_text": "fix 1"},
            {"agent_name": "analyst", "category": "logic_error", "correction_text": "fix 2"},
        ]
        sb = _mock_supabase(corrections=corrections)
        llm = _mock_llm()
        tracker = _build_tracker(llm=llm, supabase=sb)
        result = _run(tracker.find_patterns())
        assert result == []
        llm.think_structured.assert_not_called()


# ===========================================================================
# build_correction_context
# ===========================================================================

class TestBuildCorrectionContext:
    def test_empty(self) -> None:
        tracker = _build_tracker()
        assert tracker.build_correction_context([]) == ""

    def test_formats_corrections(self) -> None:
        corrections = [
            {"category": "output_format", "corrected_action": "Use bullet points"},
            {"category": "tone", "corrected_action": "Be more formal"},
            {"category": "logic_error", "correction_text": "Check nulls first"},
        ]
        tracker = _build_tracker()
        result = tracker.build_correction_context(corrections)
        assert "Past corrections" in result
        assert "Use bullet points" in result
        assert "Be more formal" in result
        assert "Check nulls first" in result

    def test_limits_to_10(self) -> None:
        corrections = [
            {"category": f"cat_{i}", "corrected_action": f"action_{i}"}
            for i in range(15)
        ]
        tracker = _build_tracker()
        result = tracker.build_correction_context(corrections)
        # Should contain action_0 through action_9, but not action_10+
        assert "action_9" in result
        assert "action_10" not in result
