"""Tests for vincera.core.scheduler — Scheduler."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

from vincera.core.scheduler import Scheduler, ScheduledTask


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    """Run an async coroutine synchronously."""
    return asyncio.run(coro)


def _mock_orchestrator():
    orch = MagicMock()
    orch.run_cycle = AsyncMock(return_value={"action": "ok"})
    orch._brain = MagicMock()
    orch._brain.cycle_count = 0
    return orch


def _mock_config():
    config = MagicMock()
    config.company_id = "comp-1"
    return config


def _mock_state():
    state = MagicMock()
    state.is_paused.return_value = False
    state.flush_queue.return_value = 0
    return state


def _build_scheduler(**overrides):
    orch = overrides.pop("orchestrator", _mock_orchestrator())
    config = overrides.pop("config", _mock_config())
    state = overrides.pop("state", _mock_state())
    sched = Scheduler(orchestrator=orch, config=config, state=state)
    mocks = {"orchestrator": orch, "config": config, "state": state}
    return sched, mocks


# ===========================================================================
# Add / remove tasks
# ===========================================================================

class TestAddRemove:
    def test_add_task(self) -> None:
        sched, _ = _build_scheduler()
        sched.add_task("t1", "Test Task", "health_check", interval_seconds=60)
        assert sched.task_count == 1

    def test_remove_task(self) -> None:
        sched, _ = _build_scheduler()
        sched.add_task("t1", "Test Task", "health_check", interval_seconds=60)
        sched.remove_task("t1")
        assert sched.task_count == 0


# ===========================================================================
# get_due_tasks
# ===========================================================================

class TestGetDueTasks:
    def test_none_due(self) -> None:
        sched, _ = _build_scheduler()
        sched.add_task("t1", "Future", "health_check", interval_seconds=60, start_delay_seconds=9999)
        assert len(sched.get_due_tasks()) == 0

    def test_one_due(self) -> None:
        sched, _ = _build_scheduler()
        sched.add_task("t1", "Now", "health_check", interval_seconds=60)
        # Manually set next_run to the past
        sched._tasks["t1"].next_run = datetime.now(timezone.utc) - timedelta(seconds=10)
        assert len(sched.get_due_tasks()) == 1


# ===========================================================================
# tick
# ===========================================================================

class TestTick:
    def test_paused(self) -> None:
        state = _mock_state()
        state.is_paused.return_value = True
        sched, _ = _build_scheduler(state=state)
        results = _run(sched.tick())
        assert results[0]["action"] == "paused"

    def test_runs_due_task(self) -> None:
        sched, mocks = _build_scheduler()
        sched.add_task("t1", "Cycle", "orchestrator_cycle", interval_seconds=60)
        sched._tasks["t1"].next_run = datetime.now(timezone.utc) - timedelta(seconds=10)
        results = _run(sched.tick())
        assert len(results) == 1
        assert results[0]["task"] == "Cycle"
        mocks["orchestrator"].run_cycle.assert_called_once()

    def test_updates_last_run(self) -> None:
        sched, _ = _build_scheduler()
        sched.add_task("t1", "Cycle", "orchestrator_cycle", interval_seconds=60)
        sched._tasks["t1"].next_run = datetime.now(timezone.utc) - timedelta(seconds=10)
        _run(sched.tick())
        assert sched._tasks["t1"].last_run is not None

    def test_increments_run_count(self) -> None:
        sched, _ = _build_scheduler()
        sched.add_task("t1", "Cycle", "orchestrator_cycle", interval_seconds=60)
        sched._tasks["t1"].next_run = datetime.now(timezone.utc) - timedelta(seconds=10)
        _run(sched.tick())
        assert sched._tasks["t1"].run_count == 1

    def test_reschedules_recurring(self) -> None:
        sched, _ = _build_scheduler()
        sched.add_task("t1", "Cycle", "orchestrator_cycle", interval_seconds=300)
        sched._tasks["t1"].next_run = datetime.now(timezone.utc) - timedelta(seconds=10)
        _run(sched.tick())
        # next_run should be in the future
        assert sched._tasks["t1"].next_run > datetime.now(timezone.utc)

    def test_disables_one_shot(self) -> None:
        sched, _ = _build_scheduler()
        sched.add_task("t1", "OneShot", "health_check", interval_seconds=0)
        sched._tasks["t1"].next_run = datetime.now(timezone.utc) - timedelta(seconds=10)
        _run(sched.tick())
        assert sched._tasks["t1"].enabled is False

    def test_handles_error(self) -> None:
        orch = _mock_orchestrator()
        orch.run_cycle = AsyncMock(side_effect=RuntimeError("boom"))
        sched, _ = _build_scheduler(orchestrator=orch)
        sched.add_task("t1", "Cycle", "orchestrator_cycle", interval_seconds=60)
        sched._tasks["t1"].next_run = datetime.now(timezone.utc) - timedelta(seconds=10)
        results = _run(sched.tick())
        assert "error" in results[0]


# ===========================================================================
# Default schedule
# ===========================================================================

class TestDefaults:
    def test_setup_default_schedule(self) -> None:
        sched, _ = _build_scheduler()
        sched.setup_default_schedule()
        assert sched.task_count == 3

    def test_enabled_task_count(self) -> None:
        sched, _ = _build_scheduler()
        sched.setup_default_schedule()
        assert sched.enabled_task_count == 3
        # Disable one
        task_id = list(sched._tasks.keys())[0]
        sched._tasks[task_id].enabled = False
        assert sched.enabled_task_count == 2


# ===========================================================================
# Lifecycle
# ===========================================================================

class TestLifecycle:
    def test_stop(self) -> None:
        sched, _ = _build_scheduler()
        sched._running = True
        sched.stop()
        assert sched._running is False

    def test_execute_unknown_callback(self) -> None:
        sched, _ = _build_scheduler()
        task = ScheduledTask(
            task_id="x", name="Bad", callback_name="nonexistent",
            interval_seconds=60, next_run=datetime.now(timezone.utc),
        )
        result = _run(sched._execute_task(task))
        assert "error" in result
