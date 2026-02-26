"""Tests for vincera.execution.rollback — RollbackManager."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

from vincera.execution.deployment_pipeline import DeploymentRecord, DeploymentStage
from vincera.execution.rollback import RollbackManager, RollbackRecord


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _mock_pipeline(rollback_success: bool = True):
    pipe = MagicMock()
    pipe.rollback = AsyncMock(return_value=rollback_success)
    pipe.get_deployment = MagicMock(return_value=DeploymentRecord(
        deployment_id="dep-1",
        automation_name="auto_invoice",
        script="print('ok')",
        current_stage=DeploymentStage.CANARY,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
    ))
    return pipe


def _mock_monitor(should_rollback: bool = False):
    mon = MagicMock()
    mon.should_rollback = AsyncMock(return_value=should_rollback)
    return mon


def _mock_supabase():
    sb = MagicMock()
    sb.log_event.return_value = None
    return sb


def _build_manager(**overrides):
    pipeline = overrides.pop("pipeline", _mock_pipeline())
    monitor = overrides.pop("monitor", _mock_monitor())
    supabase = overrides.pop("supabase", _mock_supabase())
    company_id = overrides.pop("company_id", "comp-1")
    mgr = RollbackManager(
        pipeline=pipeline,
        monitor=monitor,
        supabase=supabase,
        company_id=company_id,
    )
    return mgr, {"pipeline": pipeline, "monitor": monitor, "supabase": supabase}


# ===========================================================================
# auto_rollback
# ===========================================================================

class TestAutoRollback:
    def test_creates_record_with_auto_trigger(self) -> None:
        mgr, _ = _build_manager()
        record = _run(mgr.auto_rollback("dep-1", "health failing"))
        assert isinstance(record, RollbackRecord)
        assert record.trigger == "auto"
        assert record.deployment_id == "dep-1"
        assert record.reason == "health failing"

    def test_calls_pipeline_rollback(self) -> None:
        mgr, mocks = _build_manager()
        _run(mgr.auto_rollback("dep-1", "health failing"))
        mocks["pipeline"].rollback.assert_called_once_with("dep-1", "health failing")

    def test_logs_event(self) -> None:
        mgr, mocks = _build_manager()
        _run(mgr.auto_rollback("dep-1", "health failing"))
        mocks["supabase"].log_event.assert_called()

    def test_records_stage_before_rollback(self) -> None:
        mgr, _ = _build_manager()
        record = _run(mgr.auto_rollback("dep-1", "reason"))
        assert record.rolled_back_from_stage == "canary"


# ===========================================================================
# manual_rollback
# ===========================================================================

class TestManualRollback:
    def test_creates_record_with_manual_trigger(self) -> None:
        mgr, _ = _build_manager()
        record = _run(mgr.manual_rollback("dep-1", "user requested"))
        assert record.trigger == "manual"

    def test_calls_pipeline_rollback(self) -> None:
        mgr, mocks = _build_manager()
        _run(mgr.manual_rollback("dep-1", "user requested"))
        mocks["pipeline"].rollback.assert_called_once_with("dep-1", "user requested")


# ===========================================================================
# check_and_rollback
# ===========================================================================

class TestCheckAndRollback:
    def test_triggers_when_failing(self) -> None:
        mgr, mocks = _build_manager(monitor=_mock_monitor(should_rollback=True))
        record = _run(mgr.check_and_rollback("dep-1"))
        assert record is not None
        assert record.trigger == "auto"
        mocks["pipeline"].rollback.assert_called_once()

    def test_returns_none_when_healthy(self) -> None:
        mgr, mocks = _build_manager(monitor=_mock_monitor(should_rollback=False))
        record = _run(mgr.check_and_rollback("dep-1"))
        assert record is None
        mocks["pipeline"].rollback.assert_not_called()


# ===========================================================================
# get_history
# ===========================================================================

class TestGetHistory:
    def test_returns_all_records(self) -> None:
        mgr, _ = _build_manager()
        _run(mgr.auto_rollback("dep-1", "reason1"))
        _run(mgr.manual_rollback("dep-2", "reason2"))
        history = mgr.get_history()
        assert len(history) == 2

    def test_filters_by_deployment(self) -> None:
        mgr, _ = _build_manager()
        _run(mgr.auto_rollback("dep-1", "reason1"))
        _run(mgr.manual_rollback("dep-2", "reason2"))
        history = mgr.get_history(deployment_id="dep-1")
        assert len(history) == 1
        assert history[0].deployment_id == "dep-1"

    def test_empty_when_no_rollbacks(self) -> None:
        mgr, _ = _build_manager()
        assert mgr.get_history() == []

    def test_handles_pipeline_failure(self) -> None:
        pipeline = _mock_pipeline(rollback_success=False)
        mgr, _ = _build_manager(pipeline=pipeline)
        record = _run(mgr.auto_rollback("dep-1", "reason"))
        # Record is still created even if pipeline returns False
        assert isinstance(record, RollbackRecord)
