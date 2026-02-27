"""Tests for vincera.verification — safety, fact checking, confidence, and verifier."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ============================================================
# Helpers
# ============================================================


def _run(coro):
    """Run an async coroutine synchronously."""
    return asyncio.run(coro)


def _mock_llm(think_response: str = "No issues found.", structured_response: dict | None = None):
    """Create a mock OpenRouterClient."""
    llm = MagicMock()
    llm.think = AsyncMock(return_value=think_response)
    llm.think_structured = AsyncMock(return_value=structured_response or {"tags": ["test"]})
    return llm


# ============================================================
# Safety checks — reversibility (rule-based)
# ============================================================


class TestSafetyReversibility:
    def test_blocks_delete(self) -> None:
        from vincera.verification.safety import reversibility_check

        llm = _mock_llm()
        action = {"description": "DELETE FROM users WHERE id = 5", "commands": ["DELETE FROM users WHERE id = 5"]}
        result = _run(reversibility_check(action, llm))
        assert result.passed is False
        assert "DELETE" in result.reason.upper() or "delete" in result.reason.lower()

    def test_blocks_drop(self) -> None:
        from vincera.verification.safety import reversibility_check

        llm = _mock_llm()
        action = {"description": "Drop the sessions table", "commands": ["DROP TABLE sessions"]}
        result = _run(reversibility_check(action, llm))
        assert result.passed is False

    def test_blocks_rm_rf(self) -> None:
        from vincera.verification.safety import reversibility_check

        llm = _mock_llm()
        action = {"description": "Clean temp files", "commands": ["rm -rf /tmp/data"]}
        result = _run(reversibility_check(action, llm))
        assert result.passed is False

    def test_blocks_external_http(self) -> None:
        from vincera.verification.safety import reversibility_check

        llm = _mock_llm()
        action = {"description": "Send data externally", "commands": ["POST https://external.com/webhook"]}
        result = _run(reversibility_check(action, llm))
        assert result.passed is False

    def test_blocks_smtp(self) -> None:
        from vincera.verification.safety import reversibility_check

        llm = _mock_llm()
        action = {"description": "Send email via SMTP", "commands": ["SMTP send notification"]}
        result = _run(reversibility_check(action, llm))
        assert result.passed is False

    def test_allows_select(self) -> None:
        from vincera.verification.safety import reversibility_check

        llm = _mock_llm()
        action = {"description": "Query orders", "commands": ["SELECT * FROM orders"]}
        result = _run(reversibility_check(action, llm))
        assert result.passed is True

    def test_allows_read(self) -> None:
        from vincera.verification.safety import reversibility_check

        llm = _mock_llm()
        action = {"description": "Read report file", "commands": ["read file /data/report.csv"]}
        result = _run(reversibility_check(action, llm))
        assert result.passed is True


# ============================================================
# Fact checker
# ============================================================


class TestFactChecker:
    def test_flags_unsourced_claim(self) -> None:
        from vincera.verification.fact_checker import fact_check

        llm = _mock_llm(think_response="FLAGGED: Revenue is $5M — no data source provided.")
        action = {"description": "Revenue is $5M this quarter", "data_sources": []}
        result = _run(fact_check(action, llm))
        assert result.passed is False

    def test_passes_when_sourced(self) -> None:
        from vincera.verification.fact_checker import fact_check

        llm = _mock_llm(think_response="ALL_CLEAR: All claims have verifiable sources.")
        action = {"description": "Report shows 100 orders from DB", "data_sources": ["orders table"]}
        result = _run(fact_check(action, llm))
        assert result.passed is True


class TestNoFabrication:
    def test_catches_invented_number(self) -> None:
        from vincera.verification.fact_checker import no_fabrication

        llm = _mock_llm(think_response="FLAGGED: The value '99.7% accuracy' appears invented with no backing data.")
        action = {"description": "Model has 99.7% accuracy", "data_sources": []}
        result = _run(no_fabrication(action, llm))
        assert result.passed is False

    def test_passes_clean(self) -> None:
        from vincera.verification.fact_checker import no_fabrication

        llm = _mock_llm(think_response="ALL_CLEAR: No fabricated data detected.")
        action = {"description": "Deploy build v1.2.3", "data_sources": ["CI pipeline"]}
        result = _run(no_fabrication(action, llm))
        assert result.passed is True


# ============================================================
# Confidence scoring
# ============================================================


class TestConfidence:
    def test_perfect_score(self) -> None:
        from vincera.verification.confidence import calculate_confidence
        from vincera.verification.verifier import CheckResult

        checks = [
            CheckResult(name="c1", passed=True, reason="ok"),
            CheckResult(name="c2", passed=True, reason="ok"),
        ]
        action = {"data_sources": ["db"], "complexity": "low"}
        score = calculate_confidence(checks, action)
        assert score == 1.0

    def test_deductions_for_failures(self) -> None:
        from vincera.verification.confidence import calculate_confidence
        from vincera.verification.verifier import CheckResult

        checks = [
            CheckResult(name="c1", passed=False, reason="fail"),
            CheckResult(name="c2", passed=True, reason="ok"),
        ]
        action = {"data_sources": ["db"]}
        score = calculate_confidence(checks, action)
        assert score == pytest.approx(0.85, abs=0.01)

    def test_no_data_sources_penalty(self) -> None:
        from vincera.verification.confidence import calculate_confidence
        from vincera.verification.verifier import CheckResult

        checks = [CheckResult(name="c1", passed=True, reason="ok")]
        action = {}  # no data_sources
        score = calculate_confidence(checks, action)
        assert score == pytest.approx(0.9, abs=0.01)

    def test_high_complexity_penalty(self) -> None:
        from vincera.verification.confidence import calculate_confidence
        from vincera.verification.verifier import CheckResult

        checks = [CheckResult(name="c1", passed=True, reason="ok")]
        action = {"data_sources": ["db"], "complexity": "high"}
        score = calculate_confidence(checks, action)
        assert score == pytest.approx(0.95, abs=0.01)

    def test_floor_at_zero(self) -> None:
        from vincera.verification.confidence import calculate_confidence
        from vincera.verification.verifier import CheckResult

        checks = [CheckResult(name=f"c{i}", passed=False, reason="fail") for i in range(10)]
        action = {"complexity": "high"}
        score = calculate_confidence(checks, action)
        assert score == 0.0


# ============================================================
# Verifier — full pipeline
# ============================================================


class TestVerifier:
    def test_all_checks_must_pass(self) -> None:
        from vincera.verification.verifier import Verifier

        # One LLM call returns FLAGGED → one check will fail
        llm = _mock_llm(think_response="FLAGGED: Suspicious data found.")
        verifier = Verifier(llm)
        action = {"description": "Do something risky", "commands": [], "data_sources": []}
        context = {}
        result = _run(verifier.verify(action, context))
        assert result.passed is False

    def test_passes_when_all_clear(self) -> None:
        from vincera.verification.verifier import Verifier

        llm = _mock_llm(think_response="ALL_CLEAR: Everything looks good.")
        verifier = Verifier(llm)
        action = {"description": "Read orders report", "commands": ["SELECT * FROM orders"], "data_sources": ["orders table"]}
        context = {}
        result = _run(verifier.verify(action, context))
        assert result.passed is True
        assert result.confidence > 0.7

    def test_confidence_below_threshold(self) -> None:
        from vincera.verification.verifier import Verifier

        # Multiple FLAGGED responses → low confidence
        llm = _mock_llm(think_response="FLAGGED: issue found.")
        verifier = Verifier(llm)
        action = {"description": "Risky op", "commands": [], "data_sources": [], "complexity": "high"}
        context = {}
        result = _run(verifier.verify(action, context))
        assert result.passed is False
        assert result.blocked_reason is not None
        assert "confidence" in result.blocked_reason.lower() or result.confidence < 0.7


class TestHighStakes:
    def test_both_must_agree(self) -> None:
        from vincera.verification.verifier import Verifier

        llm = _mock_llm(think_response="ALL_CLEAR: Safe to proceed.")
        verifier = Verifier(llm)
        action = {"description": "Safe deploy", "commands": [], "data_sources": ["ci"]}
        context = {}
        result = _run(verifier.verify_high_stakes(action, context))
        assert result.passed is True

    def test_disagreement(self) -> None:
        from vincera.verification.verifier import Verifier

        call_count = 0

        async def _alternating_think(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count % 2 == 1:
                return "ALL_CLEAR: Looks fine."
            return "FLAGGED: Potential risk."

        llm = _mock_llm()
        llm.think = AsyncMock(side_effect=_alternating_think)
        verifier = Verifier(llm)
        action = {"description": "Risky deploy", "commands": [], "data_sources": []}
        context = {}
        result = _run(verifier.verify_high_stakes(action, context))
        assert result.passed is False
        assert "disagree" in result.blocked_reason.lower()

    def test_both_fail(self) -> None:
        from vincera.verification.verifier import Verifier

        llm = _mock_llm(think_response="FLAGGED: Major risk detected.")
        verifier = Verifier(llm)
        action = {"description": "Dangerous op", "commands": [], "data_sources": []}
        context = {}
        result = _run(verifier.verify_high_stakes(action, context))
        assert result.passed is False
