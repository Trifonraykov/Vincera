"""Tests for vincera.execution.canary — CanaryExecutor."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

from vincera.execution.canary import (
    CanaryExecutor,
    CanaryState,
    CanaryStatus,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _mock_sandbox():
    sb = MagicMock()
    return sb


def _mock_supabase():
    sb = MagicMock()
    sb.update_automation_status.return_value = {"id": "auto-1"}
    sb.log_event.return_value = None
    return sb


def _build_executor(**overrides):
    sandbox = overrides.pop("sandbox", _mock_sandbox())
    supabase = overrides.pop("supabase", _mock_supabase())
    company_id = overrides.pop("company_id", "comp-1")
    exe = CanaryExecutor(
        sandbox=sandbox,
        supabase=supabase,
        company_id=company_id,
    )
    return exe, {"sandbox": sandbox, "supabase": supabase}


# ===========================================================================
# start_canary
# ===========================================================================

class TestStartCanary:
    def test_creates_state(self) -> None:
        exe, _ = _build_executor()
        state = _run(exe.start_canary("dep-1", "print('ok')", canary_percentage=10))
        assert isinstance(state, CanaryState)
        assert state.deployment_id == "dep-1"
        assert state.status == CanaryStatus.RUNNING
        assert state.canary_percentage == 10
        assert state.total_executions == 0

    def test_default_percentage(self) -> None:
        exe, _ = _build_executor()
        state = _run(exe.start_canary("dep-1", "print('ok')"))
        assert state.canary_percentage == 10

    def test_persists_to_supabase(self) -> None:
        exe, mocks = _build_executor()
        _run(exe.start_canary("dep-1", "print('ok')"))
        mocks["supabase"].log_event.assert_called()


# ===========================================================================
# record_execution
# ===========================================================================

class TestRecordExecution:
    def test_success_increments(self) -> None:
        exe, _ = _build_executor()
        _run(exe.start_canary("dep-1", "print('ok')"))
        rec = _run(exe.record_execution("dep-1", success=True))
        state = exe.get_state("dep-1")
        assert state.total_executions == 1
        assert state.successful_executions == 1
        assert state.failed_executions == 0

    def test_failure_increments(self) -> None:
        exe, _ = _build_executor()
        _run(exe.start_canary("dep-1", "print('ok')"))
        _run(exe.record_execution("dep-1", success=False))
        state = exe.get_state("dep-1")
        assert state.total_executions == 1
        assert state.failed_executions == 1
        assert state.successful_executions == 0

    def test_multiple_executions_accumulate(self) -> None:
        exe, _ = _build_executor()
        _run(exe.start_canary("dep-1", "print('ok')"))
        for _ in range(3):
            _run(exe.record_execution("dep-1", success=True))
        _run(exe.record_execution("dep-1", success=False))
        state = exe.get_state("dep-1")
        assert state.total_executions == 4
        assert state.successful_executions == 3
        assert state.failed_executions == 1

    def test_record_returns_execution(self) -> None:
        exe, _ = _build_executor()
        _run(exe.start_canary("dep-1", "print('ok')"))
        rec = _run(exe.record_execution("dep-1", success=True, metadata={"key": "val"}))
        assert rec.deployment_id == "dep-1"
        assert rec.success is True


# ===========================================================================
# evaluate
# ===========================================================================

class TestEvaluate:
    def test_running_when_too_few(self) -> None:
        exe, _ = _build_executor()
        _run(exe.start_canary("dep-1", "print('ok')"))
        _run(exe.record_execution("dep-1", success=True))
        status = _run(exe.evaluate("dep-1", min_executions=5))
        assert status == CanaryStatus.RUNNING

    def test_passed_high_success_rate(self) -> None:
        exe, _ = _build_executor()
        _run(exe.start_canary("dep-1", "print('ok')"))
        for _ in range(10):
            _run(exe.record_execution("dep-1", success=True))
        status = _run(exe.evaluate("dep-1", min_executions=5, success_threshold=0.9))
        assert status == CanaryStatus.PASSED

    def test_failed_low_success_rate(self) -> None:
        exe, _ = _build_executor()
        _run(exe.start_canary("dep-1", "print('ok')"))
        for _ in range(3):
            _run(exe.record_execution("dep-1", success=True))
        for _ in range(7):
            _run(exe.record_execution("dep-1", success=False))
        status = _run(exe.evaluate("dep-1", min_executions=5, success_threshold=0.9))
        assert status == CanaryStatus.FAILED

    def test_edge_at_exact_threshold(self) -> None:
        exe, _ = _build_executor()
        _run(exe.start_canary("dep-1", "print('ok')"))
        # 9 success, 1 failure = 90% = exactly threshold
        for _ in range(9):
            _run(exe.record_execution("dep-1", success=True))
        _run(exe.record_execution("dep-1", success=False))
        status = _run(exe.evaluate("dep-1", min_executions=5, success_threshold=0.9))
        assert status == CanaryStatus.PASSED


# ===========================================================================
# abort
# ===========================================================================

class TestAbort:
    def test_abort_changes_status(self) -> None:
        exe, _ = _build_executor()
        _run(exe.start_canary("dep-1", "print('ok')"))
        state = _run(exe.abort("dep-1", "too risky"))
        assert state.status == CanaryStatus.ABORTED

    def test_abort_logs_event(self) -> None:
        exe, mocks = _build_executor()
        _run(exe.start_canary("dep-1", "print('ok')"))
        _run(exe.abort("dep-1", "too risky"))
        # At least the start + abort calls
        assert mocks["supabase"].log_event.call_count >= 2


# ===========================================================================
# get_state
# ===========================================================================

class TestGetState:
    def test_returns_none_for_unknown(self) -> None:
        exe, _ = _build_executor()
        assert exe.get_state("nonexistent") is None
