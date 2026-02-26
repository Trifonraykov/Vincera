"""Tests for vincera.agents.analyst — AnalystAgent."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from vincera.agents.analyst import AnalystAgent
from vincera.execution.monitor import HealthReport, HealthStatus


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _mock_settings(tmp_path: Path):
    settings = MagicMock()
    settings.home_dir = tmp_path / "VinceraHQ"
    settings.home_dir.mkdir(parents=True, exist_ok=True)
    (settings.home_dir / "agents").mkdir(parents=True, exist_ok=True)
    return settings


def _mock_supabase():
    sb = MagicMock()
    sb.send_message.return_value = {"id": "msg-1"}
    sb.log_event.return_value = None
    sb.add_playbook_entry.return_value = {"id": "pb-1"}
    sb.query_playbook.return_value = []
    sb.query_knowledge.return_value = []
    return sb


def _mock_llm(findings: list | None = None):
    llm = MagicMock()
    llm.think = AsyncMock(return_value="Analysis complete.")
    llm.think_structured = AsyncMock(return_value={
        "findings": findings or [],
        "opportunities": [
            {"name": "Batch invoicing", "description": "Combine invoices", "estimated_impact": "high", "complexity": "medium"},
        ],
    })
    return llm


def _mock_monitor(reports: dict | None = None):
    """Mock monitor. reports maps deployment_id → HealthReport."""
    mon = MagicMock()
    _reports = reports or {}

    async def _assess(dep_id):
        if dep_id in _reports:
            return _reports[dep_id]
        return HealthReport(
            deployment_id=dep_id,
            status=HealthStatus.UNKNOWN,
            breached_rules=[],
            metrics={},
            checked_at="2026-01-01T00:00:00+00:00",
        )

    mon.assess_health = AsyncMock(side_effect=_assess)
    mon.get_execution_logs = MagicMock(return_value=[])
    return mon


def _mock_priority_engine():
    return MagicMock()


def _build_analyst(tmp_path: Path, **overrides):
    llm = overrides.pop("llm", _mock_llm())
    monitor = overrides.pop("monitor", _mock_monitor())
    priority_engine = overrides.pop("priority_engine", _mock_priority_engine())

    agent = AnalystAgent(
        name="analyst",
        company_id="comp-1",
        config=_mock_settings(tmp_path),
        llm=llm,
        supabase=_mock_supabase(),
        state=MagicMock(),
        verifier=MagicMock(),
        monitor=monitor,
        priority_engine=priority_engine,
    )
    return agent, {"llm": llm, "monitor": monitor, "priority_engine": priority_engine}


# ===========================================================================
# performance_review
# ===========================================================================

class TestPerformanceReview:
    def test_no_deployments(self, tmp_path: Path) -> None:
        agent, _ = _build_analyst(tmp_path)
        result = _run(agent.run({"type": "performance_review", "deployment_ids": []}))
        assert result["findings"] == []
        assert result["deployments_analyzed"] == 0

    def test_finds_high_error(self, tmp_path: Path) -> None:
        monitor = _mock_monitor(reports={
            "dep-1": HealthReport(
                deployment_id="dep-1",
                status=HealthStatus.DEGRADED,
                breached_rules=["error_rate_degraded"],
                metrics={"error_rate": 0.20},
                checked_at="2026-01-01T00:00:00+00:00",
            ),
        })
        agent, _ = _build_analyst(tmp_path, monitor=monitor)
        result = _run(agent.run({"type": "performance_review", "deployment_ids": ["dep-1"]}))
        assert result["findings_count"] >= 1
        error_findings = [f for f in result["findings"] if "error" in f.get("finding", "").lower()]
        assert len(error_findings) >= 1

    def test_finds_slow(self, tmp_path: Path) -> None:
        monitor = _mock_monitor(reports={
            "dep-1": HealthReport(
                deployment_id="dep-1",
                status=HealthStatus.DEGRADED,
                breached_rules=["latency_degraded"],
                metrics={"avg_latency": 45.0},
                checked_at="2026-01-01T00:00:00+00:00",
            ),
        })
        agent, _ = _build_analyst(tmp_path, monitor=monitor)
        result = _run(agent.run({"type": "performance_review", "deployment_ids": ["dep-1"]}))
        latency_findings = [f for f in result["findings"] if "time" in f.get("finding", "").lower() or "latency" in f.get("finding", "").lower()]
        assert len(latency_findings) >= 1

    def test_uses_llm(self, tmp_path: Path) -> None:
        llm = _mock_llm(findings=[{"finding": "Pattern detected", "severity": "low", "recommendation": "Monitor"}])
        monitor = _mock_monitor(reports={
            "dep-1": HealthReport(
                deployment_id="dep-1",
                status=HealthStatus.HEALTHY,
                breached_rules=[],
                metrics={"error_rate": 0.01},
                checked_at="2026-01-01T00:00:00+00:00",
            ),
        })
        agent, mocks = _build_analyst(tmp_path, llm=llm, monitor=monitor)
        _run(agent.run({"type": "performance_review", "deployment_ids": ["dep-1"]}))
        mocks["llm"].think_structured.assert_called()

    def test_sends_message(self, tmp_path: Path) -> None:
        monitor = _mock_monitor(reports={
            "dep-1": HealthReport(
                deployment_id="dep-1",
                status=HealthStatus.DEGRADED,
                breached_rules=["error_rate_degraded"],
                metrics={"error_rate": 0.25},
                checked_at="2026-01-01T00:00:00+00:00",
            ),
        })
        agent, _ = _build_analyst(tmp_path, monitor=monitor)
        _run(agent.run({"type": "performance_review", "deployment_ids": ["dep-1"]}))
        assert agent._sb.send_message.call_count >= 1


# ===========================================================================
# optimization_scan
# ===========================================================================

class TestOptimizationScan:
    def test_returns_opportunities(self, tmp_path: Path) -> None:
        agent, _ = _build_analyst(tmp_path)
        result = _run(agent.run({"type": "optimization_scan", "company_model": {"name": "TestCo"}}))
        assert result["status"] == "complete"
        assert len(result["opportunities"]) >= 1

    def test_sends_message(self, tmp_path: Path) -> None:
        agent, _ = _build_analyst(tmp_path)
        _run(agent.run({"type": "optimization_scan", "company_model": {"name": "TestCo"}}))
        assert agent._sb.send_message.call_count >= 1


# ===========================================================================
# trend_analysis
# ===========================================================================

class TestTrendAnalysis:
    def test_stable(self, tmp_path: Path) -> None:
        monitor = _mock_monitor(reports={
            "dep-1": HealthReport(
                deployment_id="dep-1",
                status=HealthStatus.HEALTHY,
                breached_rules=[],
                metrics={"error_rate": 0.01, "avg_latency": 1.0},
                checked_at="2026-01-01T00:00:00+00:00",
            ),
        })
        monitor.get_execution_logs = MagicMock(return_value=[{"success": True}])
        agent, _ = _build_analyst(tmp_path, monitor=monitor)
        result = _run(agent.run({"type": "trend_analysis", "deployment_id": "dep-1"}))
        assert result["trend"] == "stable"

    def test_degrading(self, tmp_path: Path) -> None:
        monitor = _mock_monitor(reports={
            "dep-1": HealthReport(
                deployment_id="dep-1",
                status=HealthStatus.DEGRADED,
                breached_rules=["error_rate_degraded"],
                metrics={"error_rate": 0.15},
                checked_at="2026-01-01T00:00:00+00:00",
            ),
        })
        monitor.get_execution_logs = MagicMock(return_value=[{"success": True}])
        agent, _ = _build_analyst(tmp_path, monitor=monitor)
        result = _run(agent.run({"type": "trend_analysis", "deployment_id": "dep-1"}))
        assert result["trend"] == "degrading"

    def test_no_data(self, tmp_path: Path) -> None:
        monitor = _mock_monitor()
        monitor.get_execution_logs = MagicMock(return_value=[])
        agent, _ = _build_analyst(tmp_path, monitor=monitor)
        result = _run(agent.run({"type": "trend_analysis", "deployment_id": "dep-x"}))
        assert result["status"] == "error"


# ===========================================================================
# unknown task type
# ===========================================================================

class TestUnknownTask:
    def test_unknown(self, tmp_path: Path) -> None:
        agent, _ = _build_analyst(tmp_path)
        result = _run(agent.run({"type": "invalid"}))
        assert result["status"] == "error"
