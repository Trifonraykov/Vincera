"""Tests for vincera.agents.operator — OperatorAgent."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from vincera.agents.operator import OperatorAgent
from vincera.execution.canary import CanaryState, CanaryStatus
from vincera.execution.monitor import HealthReport, HealthStatus
from vincera.execution.sandbox import SandboxResult


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


def _mock_state():
    state = MagicMock()
    state.add_action = MagicMock()
    state.update_agent_status = MagicMock()
    return state


def _mock_sandbox(success: bool = True):
    sb = MagicMock()
    sb.execute_python = AsyncMock(return_value=SandboxResult(
        success=success,
        exit_code=0 if success else 1,
        stdout="output ok" if success else "",
        stderr="" if success else "script error",
        execution_time_seconds=0.5,
        sandbox_type="subprocess",
    ))
    return sb


def _mock_monitor():
    mon = MagicMock()
    mon.add_execution_log = MagicMock()
    mon.assess_health = AsyncMock(return_value=HealthReport(
        deployment_id="dep-1",
        status=HealthStatus.HEALTHY,
        breached_rules=[],
        metrics={"error_rate": 0.0},
        checked_at="2026-01-01T00:00:00+00:00",
    ))
    mon.should_rollback = AsyncMock(return_value=False)
    mon.get_execution_logs = MagicMock(return_value=[])
    return mon


def _mock_canary():
    can = MagicMock()
    can.start_canary = AsyncMock(return_value=CanaryState(
        deployment_id="dep-1",
        status=CanaryStatus.RUNNING,
        canary_percentage=10,
        script="print('ok')",
        started_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
    ))
    can.record_execution = AsyncMock()
    can.evaluate = AsyncMock(return_value=CanaryStatus.RUNNING)
    return can


def _mock_pipeline():
    pipe = MagicMock()
    return pipe


def _build_operator(tmp_path: Path, **overrides):
    sandbox = overrides.pop("sandbox", _mock_sandbox())
    monitor = overrides.pop("monitor", _mock_monitor())
    canary = overrides.pop("canary", _mock_canary())
    pipeline = overrides.pop("pipeline", _mock_pipeline())

    agent = OperatorAgent(
        name="operator",
        company_id="comp-1",
        config=_mock_settings(tmp_path),
        llm=MagicMock(),
        supabase=_mock_supabase(),
        state=_mock_state(),
        verifier=MagicMock(),
        sandbox=sandbox,
        monitor=monitor,
        canary=canary,
        pipeline=pipeline,
    )
    return agent, {"sandbox": sandbox, "monitor": monitor, "canary": canary, "pipeline": pipeline}


# ===========================================================================
# execute_automation
# ===========================================================================

class TestExecuteAutomation:
    def test_success(self, tmp_path: Path) -> None:
        agent, mocks = _build_operator(tmp_path)
        result = _run(agent.run({
            "type": "execute_automation",
            "deployment_id": "dep-1",
            "script": "print('ok')",
            "automation_name": "auto_invoice",
        }))
        assert result["status"] == "success"
        assert result["execution_time"] == 0.5
        mocks["monitor"].add_execution_log.assert_called_once()

    def test_failure(self, tmp_path: Path) -> None:
        agent, mocks = _build_operator(tmp_path, sandbox=_mock_sandbox(success=False))
        result = _run(agent.run({
            "type": "execute_automation",
            "deployment_id": "dep-1",
            "script": "bad",
            "automation_name": "auto_invoice",
        }))
        assert result["status"] == "failed"

    def test_sends_message(self, tmp_path: Path) -> None:
        agent, _ = _build_operator(tmp_path)
        _run(agent.run({
            "type": "execute_automation",
            "deployment_id": "dep-1",
            "script": "print('ok')",
            "automation_name": "auto_invoice",
        }))
        assert agent._sb.send_message.call_count >= 1


# ===========================================================================
# run_canary
# ===========================================================================

class TestRunCanary:
    def test_starts_canary(self, tmp_path: Path) -> None:
        agent, mocks = _build_operator(tmp_path)
        result = _run(agent.run({
            "type": "run_canary",
            "deployment_id": "dep-1",
            "automation_name": "auto_invoice",
            "script": "print('ok')",
        }))
        mocks["canary"].start_canary.assert_called_once()
        assert "deployment_id" in result

    def test_records_execution(self, tmp_path: Path) -> None:
        agent, mocks = _build_operator(tmp_path)
        _run(agent.run({
            "type": "run_canary",
            "deployment_id": "dep-1",
            "automation_name": "auto_invoice",
            "script": "print('ok')",
        }))
        mocks["canary"].record_execution.assert_called_once()


# ===========================================================================
# health_check
# ===========================================================================

class TestHealthCheck:
    def test_healthy(self, tmp_path: Path) -> None:
        agent, _ = _build_operator(tmp_path)
        result = _run(agent.run({
            "type": "health_check",
            "deployment_ids": ["dep-1"],
        }))
        assert result["unhealthy_count"] == 0
        assert result["deployments"]["dep-1"]["status"] == "healthy"

    def test_unhealthy(self, tmp_path: Path) -> None:
        monitor = _mock_monitor()
        monitor.assess_health = AsyncMock(return_value=HealthReport(
            deployment_id="dep-1",
            status=HealthStatus.FAILING,
            breached_rules=["error_rate_failing"],
            metrics={"error_rate": 0.5},
            checked_at="2026-01-01T00:00:00+00:00",
        ))
        monitor.should_rollback = AsyncMock(return_value=True)
        agent, _ = _build_operator(tmp_path, monitor=monitor)
        result = _run(agent.run({
            "type": "health_check",
            "deployment_ids": ["dep-1"],
        }))
        assert result["unhealthy_count"] == 1

    def test_no_data(self, tmp_path: Path) -> None:
        monitor = _mock_monitor()
        monitor.assess_health = AsyncMock(return_value=HealthReport(
            deployment_id="dep-x",
            status=HealthStatus.UNKNOWN,
            breached_rules=[],
            metrics={},
            checked_at="2026-01-01T00:00:00+00:00",
        ))
        agent, _ = _build_operator(tmp_path, monitor=monitor)
        result = _run(agent.run({
            "type": "health_check",
            "deployment_ids": ["dep-x"],
        }))
        assert result["deployments"]["dep-x"]["status"] == "unknown"


# ===========================================================================
# run_batch
# ===========================================================================

class TestRunBatch:
    def test_runs_all(self, tmp_path: Path) -> None:
        agent, _ = _build_operator(tmp_path)
        result = _run(agent.run({
            "type": "run_batch",
            "automations": [
                {"type": "execute_automation", "deployment_id": "d1", "script": "print(1)", "automation_name": "a1"},
                {"type": "execute_automation", "deployment_id": "d2", "script": "print(2)", "automation_name": "a2"},
                {"type": "execute_automation", "deployment_id": "d3", "script": "print(3)", "automation_name": "a3"},
            ],
        }))
        assert result["total"] == 3
        assert result["successes"] == 3
        assert len(result["results"]) == 3

    def test_partial_failure(self, tmp_path: Path) -> None:
        sandbox = _mock_sandbox()
        call_count = {"n": 0}
        original = sandbox.execute_python

        async def _alternating(*args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 2:
                return SandboxResult(
                    success=False, exit_code=1, stdout="", stderr="err",
                    execution_time_seconds=0.1, sandbox_type="subprocess",
                )
            return SandboxResult(
                success=True, exit_code=0, stdout="ok", stderr="",
                execution_time_seconds=0.3, sandbox_type="subprocess",
            )

        sandbox.execute_python = AsyncMock(side_effect=_alternating)
        agent, _ = _build_operator(tmp_path, sandbox=sandbox)
        result = _run(agent.run({
            "type": "run_batch",
            "automations": [
                {"type": "execute_automation", "deployment_id": "d1", "script": "print(1)", "automation_name": "a1"},
                {"type": "execute_automation", "deployment_id": "d2", "script": "print(2)", "automation_name": "a2"},
                {"type": "execute_automation", "deployment_id": "d3", "script": "print(3)", "automation_name": "a3"},
            ],
        }))
        assert result["successes"] == 2


# ===========================================================================
# unknown task type
# ===========================================================================

class TestUnknownTask:
    def test_unknown(self, tmp_path: Path) -> None:
        agent, _ = _build_operator(tmp_path)
        result = _run(agent.run({"type": "invalid"}))
        assert result["status"] == "error"
