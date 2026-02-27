"""Tests for vincera.core.state — real SQLite, mocked SupabaseManager."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest


# ============================================================
# Helpers
# ============================================================


def _mock_supabase_manager() -> MagicMock:
    """Create a mock SupabaseManager with all methods returning sensible defaults."""
    mgr = MagicMock()
    mgr._company_id = "comp-123"
    mgr.update_agent_status.return_value = {"id": "status-1"}
    mgr.log_event.return_value = {"id": "event-1"}
    mgr.create_decision.return_value = "dec-123"
    mgr.resolve_decision.return_value = {"id": "dec-123"}
    mgr.update_company.return_value = {"id": "comp-1"}
    mgr.send_message.return_value = {"id": "msg-1"}
    return mgr


def _make_state(tmp_path: Path, supabase_mgr=None):
    """Create a GlobalState with real SQLite and optional mock Supabase."""
    from vincera.core.state import GlobalState

    mgr = supabase_mgr or _mock_supabase_manager()
    return GlobalState(db_path=tmp_path / "state.db", supabase_manager=mgr)


# ============================================================
# Dual write
# ============================================================


class TestDualWrite:
    def test_update_agent_status_writes_sqlite_and_supabase(self, tmp_path: Path) -> None:
        mock_sb = _mock_supabase_manager()
        state = _make_state(tmp_path, mock_sb)

        state.update_agent_status("discovery", "active", "mapping system", "step 1")

        # SQLite should have the row
        row = state.get_agent_status("discovery")
        assert row is not None
        assert row["status"] == "active"
        assert row["current_task"] == "mapping system"

        # Supabase should have been called
        mock_sb.update_agent_status.assert_called_once()

    def test_add_action_writes_both(self, tmp_path: Path) -> None:
        mock_sb = _mock_supabase_manager()
        state = _make_state(tmp_path, mock_sb)

        state.add_action("builder", "deploy", "service-x", "success", "v1.0")

        # SQLite
        rows = state._db.query("SELECT * FROM action_history")
        assert len(rows) == 1
        assert rows[0]["action_type"] == "deploy"

        # Supabase events
        mock_sb.log_event.assert_called_once()

    def test_add_and_resolve_decision(self, tmp_path: Path) -> None:
        mock_sb = _mock_supabase_manager()
        state = _make_state(tmp_path, mock_sb)

        state.add_pending_decision("dec-1", "operator", "Restart service?")

        pending = state.get_pending_decisions()
        assert len(pending) == 1
        assert pending[0]["question"] == "Restart service?"
        assert pending[0]["status"] == "pending"

        state.resolve_decision("dec-1", "yes", "Approved by admin")

        pending = state.get_pending_decisions()
        assert len(pending) == 0  # resolved, no longer pending

        mock_sb.resolve_decision.assert_called_once()


# ============================================================
# Queue on Supabase failure
# ============================================================


class TestQueueOnFailure:
    def test_queues_on_supabase_failure(self, tmp_path: Path) -> None:
        mock_sb = _mock_supabase_manager()
        mock_sb.update_agent_status.side_effect = Exception("network error")
        state = _make_state(tmp_path, mock_sb)

        state.update_agent_status("agent1", "error", "crashed", "oops")

        # SQLite should still have the status
        row = state.get_agent_status("agent1")
        assert row is not None
        assert row["status"] == "error"

        # message_queue should have the failed Supabase call
        queue = state._db.query("SELECT * FROM message_queue")
        assert len(queue) == 1
        payload = json.loads(queue[0]["payload"])
        assert payload["method"] == "update_agent_status"

    def test_flush_queue_sends_to_supabase(self, tmp_path: Path) -> None:
        mock_sb = _mock_supabase_manager()
        mock_sb.update_agent_status.side_effect = Exception("offline")
        state = _make_state(tmp_path, mock_sb)

        state.update_agent_status("agent1", "active", "task1")

        # Now fix Supabase
        mock_sb.update_agent_status.side_effect = None
        mock_sb.update_agent_status.return_value = {"id": "ok"}

        flushed = state.flush_queue()
        assert flushed >= 1

        # Queue should be empty now
        queue = state._db.query("SELECT * FROM message_queue")
        assert len(queue) == 0


# ============================================================
# Pause flag
# ============================================================


class TestPauseFlag:
    def test_default_not_paused(self, tmp_path: Path) -> None:
        state = _make_state(tmp_path)
        assert state.is_paused() is False

    def test_set_paused_true(self, tmp_path: Path) -> None:
        mock_sb = _mock_supabase_manager()
        state = _make_state(tmp_path, mock_sb)

        state.set_paused(True)
        assert state.is_paused() is True

        state.set_paused(False)
        assert state.is_paused() is False

    def test_set_paused_calls_supabase(self, tmp_path: Path) -> None:
        mock_sb = _mock_supabase_manager()
        state = _make_state(tmp_path, mock_sb)

        state.set_paused(True)
        mock_sb.update_company.assert_called_once()


# ============================================================
# Snapshot
# ============================================================


class TestSnapshot:
    def test_save_and_load_snapshot(self, tmp_path: Path) -> None:
        state = _make_state(tmp_path)

        state.update_agent_status("agent1", "active", "task-a")
        state.update_agent_status("agent2", "idle", "none")
        state.add_action("agent1", "scan", "/etc", "ok")
        state.set_paused(True)

        snapshot_path = tmp_path / "snapshot.json"
        state.save_snapshot(snapshot_path)

        assert snapshot_path.exists()
        data = json.loads(snapshot_path.read_text())
        assert "agent_statuses" in data
        assert "action_history" in data
        assert "global_flags" in data

        # Load into a fresh state
        state2 = _make_state(tmp_path / "sub")
        state2.load_snapshot(snapshot_path)

        row = state2.get_agent_status("agent1")
        assert row is not None
        assert row["status"] == "active"
        assert state2.is_paused() is True

    def test_snapshot_round_trip_decisions(self, tmp_path: Path) -> None:
        state = _make_state(tmp_path)
        state.add_pending_decision("d1", "operator", "Scale up?")

        snapshot_path = tmp_path / "snap.json"
        state.save_snapshot(snapshot_path)

        state2 = _make_state(tmp_path / "sub2")
        state2.load_snapshot(snapshot_path)

        pending = state2.get_pending_decisions()
        assert len(pending) == 1
        assert pending[0]["decision_id"] == "d1"
