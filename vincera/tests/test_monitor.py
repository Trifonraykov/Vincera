"""Tests for vincera.execution.monitor — DeploymentMonitor."""

from __future__ import annotations

import asyncio
import time
from unittest.mock import MagicMock

from vincera.execution.monitor import (
    DeploymentMonitor,
    HealthReport,
    HealthRule,
    HealthStatus,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _mock_supabase():
    sb = MagicMock()
    sb.log_event.return_value = None
    return sb


def _build_monitor(**overrides):
    supabase = overrides.pop("supabase", _mock_supabase())
    company_id = overrides.pop("company_id", "comp-1")
    mon = DeploymentMonitor(supabase=supabase, company_id=company_id)
    return mon, {"supabase": supabase}


def _add_executions(mon, dep_id, successes: int, failures: int):
    """Add a batch of execution logs."""
    for _ in range(successes):
        mon.add_execution_log(dep_id, success=True, execution_time_seconds=0.5)
    for _ in range(failures):
        mon.add_execution_log(dep_id, success=False, execution_time_seconds=0.5)


# ===========================================================================
# default_rules
# ===========================================================================

class TestDefaultRules:
    def test_returns_rules(self) -> None:
        rules = DeploymentMonitor.default_rules()
        assert len(rules) >= 3
        assert all(isinstance(r, HealthRule) for r in rules)

    def test_rule_names(self) -> None:
        rules = DeploymentMonitor.default_rules()
        names = {r.name for r in rules}
        assert "error_rate_degraded" in names
        assert "error_rate_failing" in names
        assert "latency_degraded" in names


# ===========================================================================
# add_execution_log
# ===========================================================================

class TestAddExecutionLog:
    def test_records_entry(self) -> None:
        mon, _ = _build_monitor()
        mon.add_execution_log("dep-1", success=True, execution_time_seconds=0.3)
        logs = mon.get_execution_logs("dep-1")
        assert len(logs) == 1
        assert logs[0]["success"] is True

    def test_multiple_entries(self) -> None:
        mon, _ = _build_monitor()
        mon.add_execution_log("dep-1", success=True, execution_time_seconds=0.3)
        mon.add_execution_log("dep-1", success=False, execution_time_seconds=1.2)
        logs = mon.get_execution_logs("dep-1")
        assert len(logs) == 2

    def test_separate_deployments(self) -> None:
        mon, _ = _build_monitor()
        mon.add_execution_log("dep-1", success=True, execution_time_seconds=0.3)
        mon.add_execution_log("dep-2", success=False, execution_time_seconds=0.5)
        assert len(mon.get_execution_logs("dep-1")) == 1
        assert len(mon.get_execution_logs("dep-2")) == 1


# ===========================================================================
# assess_health
# ===========================================================================

class TestAssessHealth:
    def test_healthy_when_all_good(self) -> None:
        mon, _ = _build_monitor()
        _add_executions(mon, "dep-1", successes=10, failures=0)
        report = _run(mon.assess_health("dep-1"))
        assert isinstance(report, HealthReport)
        assert report.status == HealthStatus.HEALTHY

    def test_degraded_on_error_rate(self) -> None:
        mon, _ = _build_monitor()
        # 15% error rate → triggers degraded (threshold 10%)
        _add_executions(mon, "dep-1", successes=17, failures=3)
        report = _run(mon.assess_health("dep-1"))
        assert report.status == HealthStatus.DEGRADED

    def test_failing_on_high_error_rate(self) -> None:
        mon, _ = _build_monitor()
        # 50% error rate → triggers failing (threshold 30%)
        _add_executions(mon, "dep-1", successes=5, failures=5)
        report = _run(mon.assess_health("dep-1"))
        assert report.status == HealthStatus.FAILING

    def test_unknown_when_no_logs(self) -> None:
        mon, _ = _build_monitor()
        report = _run(mon.assess_health("dep-1"))
        assert report.status == HealthStatus.UNKNOWN

    def test_latency_rule(self) -> None:
        mon, _ = _build_monitor()
        # All executions with high latency → DEGRADED
        for _ in range(10):
            mon.add_execution_log("dep-1", success=True, execution_time_seconds=10.0)
        report = _run(mon.assess_health("dep-1"))
        assert report.status in (HealthStatus.DEGRADED, HealthStatus.FAILING)

    def test_multiple_breaches_pick_worst(self) -> None:
        mon, _ = _build_monitor()
        # 50% error rate AND high latency
        for _ in range(5):
            mon.add_execution_log("dep-1", success=True, execution_time_seconds=10.0)
        for _ in range(5):
            mon.add_execution_log("dep-1", success=False, execution_time_seconds=10.0)
        report = _run(mon.assess_health("dep-1"))
        assert report.status == HealthStatus.FAILING

    def test_breached_rules_populated(self) -> None:
        mon, _ = _build_monitor()
        _add_executions(mon, "dep-1", successes=5, failures=5)
        report = _run(mon.assess_health("dep-1"))
        assert len(report.breached_rules) > 0


# ===========================================================================
# should_rollback
# ===========================================================================

class TestShouldRollback:
    def test_true_when_failing(self) -> None:
        mon, _ = _build_monitor()
        _add_executions(mon, "dep-1", successes=3, failures=7)
        assert _run(mon.should_rollback("dep-1")) is True

    def test_false_when_degraded(self) -> None:
        mon, _ = _build_monitor()
        # 15% error → DEGRADED but not FAILING
        _add_executions(mon, "dep-1", successes=17, failures=3)
        assert _run(mon.should_rollback("dep-1")) is False

    def test_false_when_healthy(self) -> None:
        mon, _ = _build_monitor()
        _add_executions(mon, "dep-1", successes=10, failures=0)
        assert _run(mon.should_rollback("dep-1")) is False


# ===========================================================================
# get_execution_logs
# ===========================================================================

class TestGetExecutionLogs:
    def test_empty_for_unknown(self) -> None:
        mon, _ = _build_monitor()
        assert mon.get_execution_logs("nonexistent") == []
