"""Tests for vincera.core.agent_factory — AgentFactory."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from vincera.core.agent_factory import AgentFactory


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_settings(tmp_path: Path) -> MagicMock:
    settings = MagicMock()
    settings.home_dir = tmp_path / "VinceraHQ"
    settings.home_dir.mkdir(parents=True, exist_ok=True)
    (settings.home_dir / "agents").mkdir(parents=True, exist_ok=True)
    (settings.home_dir / "core").mkdir(parents=True, exist_ok=True)
    settings.company_id = "comp-1"
    settings.company_name = "TestCorp"
    settings.agent_name = "vincera"
    settings.ghost_mode_days = 7
    return settings


def _mock_llm() -> MagicMock:
    return MagicMock()


def _mock_supabase() -> MagicMock:
    sb = MagicMock()
    sb.send_message.return_value = {"id": "msg-1"}
    sb.log_event.return_value = None
    sb.add_playbook_entry.return_value = {"id": "pb-1"}
    sb.query_playbook.return_value = []
    sb.query_knowledge.return_value = []
    sb.get_unapplied_corrections.return_value = []
    return sb


def _mock_state() -> MagicMock:
    state = MagicMock()
    state.add_action = MagicMock()
    state.update_agent_status = MagicMock()
    return state


def _mock_db() -> MagicMock:
    return MagicMock()


def _create_all(tmp_path: Path) -> dict:
    return AgentFactory.create_all(
        config=_mock_settings(tmp_path),
        llm=_mock_llm(),
        supabase=_mock_supabase(),
        state=_mock_state(),
        db=_mock_db(),
    )


# ===========================================================================
# Tests
# ===========================================================================


EXPECTED_KEYS = {
    "agents", "orchestrator", "scheduler", "sandbox", "pipeline",
    "monitor", "rollback", "ghost", "authority", "corrections",
    "training_engine", "verifier", "ontology", "priority",
}

EXPECTED_AGENTS = {
    "discovery", "research", "builder", "operator",
    "analyst", "unstuck", "trainer",
}


class TestCreateAll:
    def test_returns_dict(self, tmp_path: Path) -> None:
        result = _create_all(tmp_path)
        assert isinstance(result, dict)
        assert EXPECTED_KEYS.issubset(result.keys())

    def test_has_all_agents(self, tmp_path: Path) -> None:
        result = _create_all(tmp_path)
        agents = result["agents"]
        assert isinstance(agents, dict)
        assert set(agents.keys()) == EXPECTED_AGENTS

    def test_has_orchestrator(self, tmp_path: Path) -> None:
        from vincera.core.orchestrator import Orchestrator

        result = _create_all(tmp_path)
        assert isinstance(result["orchestrator"], Orchestrator)

    def test_has_scheduler(self, tmp_path: Path) -> None:
        from vincera.core.scheduler import Scheduler

        result = _create_all(tmp_path)
        assert isinstance(result["scheduler"], Scheduler)

    def test_agents_have_correct_company_id(self, tmp_path: Path) -> None:
        result = _create_all(tmp_path)
        for name, agent in result["agents"].items():
            assert agent.company_id == "comp-1", f"{name} has wrong company_id"

    def test_monitor_has_rules(self, tmp_path: Path) -> None:
        result = _create_all(tmp_path)
        monitor = result["monitor"]
        assert len(monitor._rules) > 0

    def test_scheduler_has_tasks(self, tmp_path: Path) -> None:
        result = _create_all(tmp_path)
        scheduler = result["scheduler"]
        assert scheduler.task_count >= 3
