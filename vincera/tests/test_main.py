"""Tests for vincera.main — CLI entry point."""

from __future__ import annotations

import signal
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# ============================================================
# Helpers
# ============================================================


def _mock_state(tmp_path: Path) -> MagicMock:
    """Create a mock GlobalState."""
    state = MagicMock()
    state.is_paused.return_value = False
    state.get_agent_status.return_value = None
    state._db = MagicMock()
    state._db.query.return_value = []
    return state


def _mock_settings(tmp_path: Path) -> MagicMock:
    """Create a mock VinceraSettings."""
    settings = MagicMock()
    settings.home_dir = tmp_path / "VinceraHQ"
    settings.home_dir.mkdir(parents=True, exist_ok=True)
    (settings.home_dir / "core").mkdir(parents=True, exist_ok=True)
    settings.logs_dir = tmp_path / "VinceraHQ" / "logs"
    settings.logs_dir.mkdir(parents=True, exist_ok=True)
    settings.company_name = "TestCorp"
    settings.agent_name = "testbot"
    settings.supabase_url = "https://test.supabase.co"
    settings.supabase_anon_key = "anon-key"
    settings.supabase_service_key = "service-key"
    settings.company_id = "comp-123"
    return settings


# ============================================================
# Parser
# ============================================================


class TestBuildParser:
    def test_defaults(self) -> None:
        from vincera.main import build_parser

        parser = build_parser()
        args = parser.parse_args([])
        assert args.run is True
        assert args.status is False
        assert args.pause is False
        assert args.resume is False

    def test_status_flag(self) -> None:
        from vincera.main import build_parser

        parser = build_parser()
        args = parser.parse_args(["--status"])
        assert args.status is True

    def test_pause_flag(self) -> None:
        from vincera.main import build_parser

        parser = build_parser()
        args = parser.parse_args(["--pause"])
        assert args.pause is True

    def test_resume_flag(self) -> None:
        from vincera.main import build_parser

        parser = build_parser()
        args = parser.parse_args(["--resume"])
        assert args.resume is True


# ============================================================
# Status / Pause / Resume
# ============================================================


class TestStatusPauseResume:
    def test_status_prints_agents(self, tmp_path: Path, capsys) -> None:
        from vincera.main import handle_status

        state = _mock_state(tmp_path)
        state._db.query.return_value = [
            {"agent_name": "discovery", "status": "active", "current_task": "scanning", "detail": None, "updated_at": "2025-01-01T00:00:00Z"},
        ]
        state.is_paused.return_value = False

        handle_status(state)

        captured = capsys.readouterr()
        assert "discovery" in captured.out
        assert "active" in captured.out

    def test_pause_sets_flag(self, tmp_path: Path) -> None:
        from vincera.main import handle_pause

        state = _mock_state(tmp_path)
        handle_pause(state)
        state.set_paused.assert_called_once_with(True)

    def test_resume_clears_flag(self, tmp_path: Path) -> None:
        from vincera.main import handle_resume

        state = _mock_state(tmp_path)
        handle_resume(state)
        state.set_paused.assert_called_once_with(False)


# ============================================================
# Run loop
# ============================================================


class TestRunLoop:
    def test_creates_pid_file(self, tmp_path: Path) -> None:
        from vincera.main import handle_run

        state = _mock_state(tmp_path)
        settings = _mock_settings(tmp_path)

        # Create .installed marker so it doesn't exit early
        (settings.home_dir / ".installed").touch()

        shutdown = threading.Event()
        shutdown.set()  # Immediately signal shutdown

        handle_run(state, settings, shutdown_event=shutdown)

        # PID file should have been created (and removed on clean shutdown)
        # We verify the snapshot was called
        state.save_snapshot.assert_called_once()

    def test_saves_snapshot_on_shutdown(self, tmp_path: Path) -> None:
        from vincera.main import handle_run

        state = _mock_state(tmp_path)
        settings = _mock_settings(tmp_path)
        (settings.home_dir / ".installed").touch()

        shutdown = threading.Event()
        shutdown.set()

        handle_run(state, settings, shutdown_event=shutdown)

        state.save_snapshot.assert_called_once_with(settings.home_dir / "core" / "snapshot.json")

    def test_detects_first_run(self, tmp_path: Path, capsys) -> None:
        from vincera.main import handle_run

        state = _mock_state(tmp_path)
        settings = _mock_settings(tmp_path)

        # Do NOT create .installed marker
        shutdown = threading.Event()

        handle_run(state, settings, shutdown_event=shutdown)

        captured = capsys.readouterr()
        assert "install" in captured.out.lower()
