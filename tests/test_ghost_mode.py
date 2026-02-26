"""Tests for vincera.core.ghost_mode — GhostModeController."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from vincera.core.ghost_mode import GhostModeController


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _mock_supabase():
    sb = MagicMock()
    sb.send_message.return_value = {"id": "msg-1"}
    sb.update_company.return_value = {"id": "comp-1"}
    sb.save_ghost_report.return_value = {"id": "gr-1"}
    sb.get_ghost_reports.return_value = []
    return sb


def _mock_config():
    config = MagicMock()
    config.ghost_mode_days = 7
    return config


def _controller(sb=None, config=None):
    return GhostModeController(
        supabase=sb or _mock_supabase(),
        config=config or _mock_config(),
    )


# ===========================================================================
# start() tests
# ===========================================================================

class TestStart:
    def test_sets_ghost_status(self):
        sb = _mock_supabase()
        ctrl = _controller(sb=sb)
        _run(ctrl.start("comp-1", days=7))
        sb.update_company.assert_called_once()
        call_args = sb.update_company.call_args
        assert call_args.args[0] == "comp-1" or call_args.kwargs.get("company_id") == "comp-1"
        fields = call_args.args[1] if len(call_args.args) > 1 else call_args.kwargs.get("fields", {})
        assert fields.get("status") == "ghost"

    def test_sends_message(self):
        sb = _mock_supabase()
        ctrl = _controller(sb=sb)
        _run(ctrl.start("comp-1", days=7))
        sb.send_message.assert_called_once()
        call_args = sb.send_message.call_args
        content = call_args.args[2] if len(call_args.args) > 2 else call_args.kwargs.get("content", "")
        assert "ghost mode" in content.lower()

    def test_sets_end_date(self):
        ctrl = _controller()
        before = datetime.now(timezone.utc)
        _run(ctrl.start("comp-1", days=5))
        after = datetime.now(timezone.utc)
        assert ctrl.end_date is not None
        expected_min = before + timedelta(days=5)
        expected_max = after + timedelta(days=5)
        assert expected_min <= ctrl.end_date <= expected_max


# ===========================================================================
# Property tests
# ===========================================================================

class TestProperties:
    def test_is_active_during_ghost(self):
        ctrl = _controller()
        ctrl._ghost_mode_until = datetime.now(timezone.utc) + timedelta(days=3)
        ctrl._start_date = datetime.now(timezone.utc) - timedelta(days=1)
        assert ctrl.is_active is True

    def test_is_active_after_ghost(self):
        ctrl = _controller()
        ctrl._ghost_mode_until = datetime.now(timezone.utc) - timedelta(hours=1)
        ctrl._start_date = datetime.now(timezone.utc) - timedelta(days=8)
        assert ctrl.is_active is False

    def test_days_remaining(self):
        ctrl = _controller()
        ctrl._ghost_mode_until = datetime.now(timezone.utc) + timedelta(days=3, hours=5)
        ctrl._start_date = datetime.now(timezone.utc) - timedelta(days=4)
        assert ctrl.days_remaining == 3


# ===========================================================================
# observe / would_have tests
# ===========================================================================

class TestObservations:
    def test_observe_process_stores(self):
        ctrl = _controller()
        _run(ctrl.observe_process(
            "comp-1", "Manual invoice creation", "invoice data", 30.0, "daily"
        ))
        assert len(ctrl._observations) == 1
        assert ctrl._observations[0]["description"] == "Manual invoice creation"

    def test_would_have_automated_stores(self):
        ctrl = _controller()
        _run(ctrl.would_have_automated(
            "comp-1", "auto_invoice", "Auto-generate invoices", 5.0, "medium"
        ))
        assert len(ctrl._would_have) == 1
        assert ctrl._would_have[0]["automation_name"] == "auto_invoice"


# ===========================================================================
# generate_daily_report tests
# ===========================================================================

class TestDailyReport:
    def test_saves_report(self):
        sb = _mock_supabase()
        ctrl = _controller(sb=sb)
        ctrl._start_date = datetime.now(timezone.utc) - timedelta(days=1)
        ctrl._ghost_mode_until = datetime.now(timezone.utc) + timedelta(days=6)
        _run(ctrl.observe_process("comp-1", "Manual task", "data", 15.0, "daily"))
        _run(ctrl.generate_daily_report("comp-1"))
        sb.save_ghost_report.assert_called_once()

    def test_sends_message(self):
        sb = _mock_supabase()
        ctrl = _controller(sb=sb)
        ctrl._start_date = datetime.now(timezone.utc) - timedelta(days=1)
        ctrl._ghost_mode_until = datetime.now(timezone.utc) + timedelta(days=6)
        _run(ctrl.observe_process("comp-1", "Manual task", "data", 15.0, "daily"))
        _run(ctrl.generate_daily_report("comp-1"))
        sb.send_message.assert_called_once()

    def test_calculates_totals(self):
        sb = _mock_supabase()
        ctrl = _controller(sb=sb)
        ctrl._start_date = datetime.now(timezone.utc) - timedelta(days=1)
        ctrl._ghost_mode_until = datetime.now(timezone.utc) + timedelta(days=6)
        _run(ctrl.observe_process("comp-1", "Task A", "data", 20.0, "daily"))
        _run(ctrl.observe_process("comp-1", "Task B", "data", 10.0, "weekly"))
        _run(ctrl.would_have_automated("comp-1", "auto_a", "desc", 3.0, "low"))
        report = _run(ctrl.generate_daily_report("comp-1"))
        assert len(report["observed_processes"]) == 2
        assert len(report["would_have_automated"]) == 1
        assert report["estimated_hours_saved"] == 3.0
        assert report["estimated_tasks_automated"] == 1

    def test_clears_observations(self):
        ctrl = _controller()
        ctrl._start_date = datetime.now(timezone.utc) - timedelta(days=1)
        ctrl._ghost_mode_until = datetime.now(timezone.utc) + timedelta(days=6)
        _run(ctrl.observe_process("comp-1", "Task", "data", 10.0, "daily"))
        _run(ctrl.would_have_automated("comp-1", "auto", "desc", 2.0, "low"))
        _run(ctrl.generate_daily_report("comp-1"))
        assert len(ctrl._observations) == 0
        assert len(ctrl._would_have) == 0


# ===========================================================================
# should_end tests
# ===========================================================================

class TestShouldEnd:
    def test_true_when_expired(self):
        ctrl = _controller()
        ctrl._ghost_mode_until = datetime.now(timezone.utc) - timedelta(hours=1)
        assert _run(ctrl.should_end("comp-1")) is True

    def test_false_when_active(self):
        ctrl = _controller()
        ctrl._ghost_mode_until = datetime.now(timezone.utc) + timedelta(days=3)
        assert _run(ctrl.should_end("comp-1")) is False


# ===========================================================================
# end() tests
# ===========================================================================

class TestEnd:
    def test_sends_summary(self):
        sb = _mock_supabase()
        sb.get_ghost_reports.return_value = [
            {
                "report_date": "2024-01-01",
                "observed_processes": [{"description": "task", "estimated_time_minutes": 30}],
                "would_have_automated": [{"automation_name": "auto", "estimated_hours_saved": 2.0}],
                "estimated_hours_saved": 2.0,
                "estimated_tasks_automated": 1,
            },
            {
                "report_date": "2024-01-02",
                "observed_processes": [{"description": "task2", "estimated_time_minutes": 45}],
                "would_have_automated": [{"automation_name": "auto2", "estimated_hours_saved": 3.0}],
                "estimated_hours_saved": 3.0,
                "estimated_tasks_automated": 1,
            },
        ]
        ctrl = _controller(sb=sb)
        ctrl._start_date = datetime.now(timezone.utc) - timedelta(days=7)
        ctrl._ghost_mode_until = datetime.now(timezone.utc) - timedelta(hours=1)
        _run(ctrl.end("comp-1"))
        sb.send_message.assert_called_once()
        content = sb.send_message.call_args.args[2] if len(sb.send_message.call_args.args) > 2 else ""
        assert "ghost mode" in content.lower() or "over" in content.lower()

    def test_sets_active_status(self):
        sb = _mock_supabase()
        sb.get_ghost_reports.return_value = []
        ctrl = _controller(sb=sb)
        ctrl._start_date = datetime.now(timezone.utc) - timedelta(days=7)
        ctrl._ghost_mode_until = datetime.now(timezone.utc) - timedelta(hours=1)
        _run(ctrl.end("comp-1"))
        sb.update_company.assert_called_once()
        fields = sb.update_company.call_args.args[1] if len(sb.update_company.call_args.args) > 1 else {}
        assert fields.get("status") == "active"

    def test_compiles_all_reports(self):
        sb = _mock_supabase()
        sb.get_ghost_reports.return_value = [
            {"estimated_hours_saved": 2.0, "estimated_tasks_automated": 1,
             "observed_processes": [], "would_have_automated": [
                 {"automation_name": "a1", "estimated_hours_saved": 2.0}
             ]},
            {"estimated_hours_saved": 3.5, "estimated_tasks_automated": 2,
             "observed_processes": [], "would_have_automated": [
                 {"automation_name": "a2", "estimated_hours_saved": 1.5},
                 {"automation_name": "a3", "estimated_hours_saved": 2.0},
             ]},
        ]
        ctrl = _controller(sb=sb)
        ctrl._start_date = datetime.now(timezone.utc) - timedelta(days=7)
        ctrl._ghost_mode_until = datetime.now(timezone.utc) - timedelta(hours=1)
        _run(ctrl.end("comp-1"))
        # Verify the summary message references the totals
        content = sb.send_message.call_args.args[2] if len(sb.send_message.call_args.args) > 2 else ""
        assert "5.5" in content or "5.50" in content  # total hours saved
