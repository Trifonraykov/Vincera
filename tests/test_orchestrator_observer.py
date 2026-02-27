"""Tests for Orchestrator + SystemObserver integration (LTAN loop)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from vincera.core.orchestrator import Orchestrator, OrchestratorState
from vincera.core.system_observer import ObserverConfig, SystemDiff, SystemObserver, SystemSnapshot


# ---------------------------------------------------------------------------
# Helpers (reuse patterns from test_orchestrator.py)
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _mock_config(tmp_path: Path | None = None):
    config = MagicMock()
    home = (tmp_path or Path("/tmp/vincera_obs_test")) / "VinceraHQ"
    home.mkdir(parents=True, exist_ok=True)
    (home / "knowledge").mkdir(parents=True, exist_ok=True)
    config.home_dir = home
    config.company_id = "comp-1"
    config.company_name = "TestCorp"
    config.ghost_mode_days = 7
    return config


def _mock_supabase():
    sb = MagicMock()
    sb.get_latest_brain_state.return_value = None
    sb.save_brain_state.return_value = {"id": "bs-1"}
    sb.send_message.return_value = {"id": "msg-1"}
    sb.log_event.return_value = {"id": "ev-1"}
    sb.get_company.return_value = {"authority_level": "ask_risky"}
    return sb


def _mock_state():
    state = MagicMock()
    state.is_paused.return_value = False
    state.set_paused = MagicMock()
    return state


def _mock_llm():
    llm = MagicMock()
    llm.think = AsyncMock(return_value="ok")
    llm.think_structured = AsyncMock(return_value={
        "summary": "System stable.",
        "concerns": [],
        "opportunities": [],
        "recommended_actions": [],
    })
    return llm


def _mock_authority():
    from vincera.core.authority import ActionRiskLevel

    auth = MagicMock()
    auth.can_act.return_value = True
    auth.classify_risk.return_value = ActionRiskLevel.LOW
    auth.request_if_needed = AsyncMock(return_value=True)
    return auth


def _mock_ghost():
    ghost = MagicMock()
    ghost.is_active = False
    ghost.start_date = None
    ghost.days_remaining = 0
    ghost.start = AsyncMock()
    ghost.should_end = AsyncMock(return_value=True)
    ghost.end = AsyncMock()
    return ghost


def _mock_agent(name: str = "discovery", status: str = "idle"):
    from vincera.agents.base import AgentStatus

    agent = MagicMock()
    agent.status = AgentStatus(status)
    agent.name = name
    agent.execute = AsyncMock(return_value={"result": "done", "status": "success"})
    agent.request_approval = AsyncMock(return_value="option_a")
    return agent


def _mock_priority():
    pe = MagicMock()
    pe.merge_candidates.return_value = []
    pe.rank.return_value = []
    pe.get_next_batch.return_value = []
    pe.score.return_value = MagicMock()
    return pe


def _snapshot(**overrides) -> SystemSnapshot:
    """Create a minimal SystemSnapshot."""
    defaults = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "cpu_percent": 25.0,
        "memory_used_percent": 55.0,
        "memory_available_gb": 8.0,
        "disk_usage": [{"mountpoint": "/", "total_gb": 500, "used_gb": 200, "free_gb": 300, "percent": 40}],
        "processes": [
            {"name": "postgres", "pid": 100, "cpu_percent": 2.5},
            {"name": "nginx", "pid": 200, "cpu_percent": 0.5},
        ],
        "process_count": 2,
        "scheduled_tasks": [],
        "watched_file_changes": [],
        "databases": [],
        "database_schemas": [],
        "network_shares": [],
        "recent_log_entries": [],
    }
    defaults.update(overrides)
    return SystemSnapshot(**defaults)


def _mock_observer(snapshot: SystemSnapshot | None = None, diff: SystemDiff | None = None):
    """Return a mocked SystemObserver that returns the given snapshot and diff."""
    snap = snapshot or _snapshot()
    d = diff or SystemDiff(total_changes=0, severity="normal")

    obs = MagicMock(spec=SystemObserver)
    obs.take_snapshot = AsyncMock(return_value=snap)
    obs.diff = MagicMock(return_value=d)
    obs.last_snapshot = None
    obs.config = ObserverConfig()
    obs.run_shell_command = AsyncMock(return_value={
        "stdout": "ok", "stderr": "", "returncode": 0, "success": True,
    })
    return obs


def _build_orchestrator_with_observer(tmp_path: Path, **overrides):
    """Build Orchestrator with a mocked observer."""
    config = overrides.pop("config", _mock_config(tmp_path))
    sb = overrides.pop("supabase", _mock_supabase())
    state = overrides.pop("state", _mock_state())
    llm = overrides.pop("llm", _mock_llm())
    ontology = overrides.pop("ontology", MagicMock())
    priority = overrides.pop("priority_engine", _mock_priority())
    authority = overrides.pop("authority", _mock_authority())
    ghost = overrides.pop("ghost_controller", _mock_ghost())
    verifier = overrides.pop("verifier", MagicMock())
    agents = overrides.pop("agents", {"discovery": _mock_agent("discovery")})
    observer = overrides.pop("observer", _mock_observer())

    orch = Orchestrator(
        config=config, llm=llm, supabase=sb, state=state,
        ontology=ontology, priority_engine=priority, authority=authority,
        ghost_controller=ghost, verifier=verifier, agents=agents,
        observer=observer,
    )

    mocks = {
        "config": config, "supabase": sb, "state": state, "llm": llm,
        "ontology": ontology, "priority_engine": priority, "authority": authority,
        "ghost_controller": ghost, "verifier": verifier, "agents": agents,
        "observer": observer,
    }
    return orch, mocks


# ===========================================================================
# TestObserveAndAct — the core LTAN loop
# ===========================================================================

class TestObserveAndAct:
    def test_observation_cycle_structure(self, tmp_path: Path) -> None:
        """LTAN cycle returns correct structure with no backlog."""
        orch, mocks = _build_orchestrator_with_observer(tmp_path)
        orch._brain.current_phase = "active"
        # Mark as having completed tasks so we hit continuous improvement
        orch._brain.completed_tasks = [{"name": "x", "status": "done"}]
        orch._brain.last_discovery_at = "2099-01-01T00:00:00+00:00"
        orch._brain.last_analysis_at = "2099-01-01T00:00:00+00:00"
        orch._brain.last_training_at = "2099-01-01T00:00:00+00:00"
        orch._brain.last_opportunity_scan_at = "2099-01-01T00:00:00+00:00"

        result = _run(orch.run_cycle())
        assert result["action"] == "observation_cycle"
        assert "cycle" in result
        assert "diff_severity" in result

    def test_takes_snapshot(self, tmp_path: Path) -> None:
        """Observer.take_snapshot is called every cycle."""
        observer = _mock_observer()
        orch, _ = _build_orchestrator_with_observer(tmp_path, observer=observer)
        orch._brain.current_phase = "active"
        _run(orch.run_cycle())
        observer.take_snapshot.assert_called_once()

    def test_computes_diff(self, tmp_path: Path) -> None:
        """Observer.diff is called with previous and new snapshot."""
        observer = _mock_observer()
        orch, _ = _build_orchestrator_with_observer(tmp_path, observer=observer)
        orch._brain.current_phase = "active"
        _run(orch.run_cycle())
        observer.diff.assert_called_once()

    def test_stores_snapshot_in_brain(self, tmp_path: Path) -> None:
        """Snapshot is persisted to brain state."""
        snap = _snapshot(cpu_percent=42.0)
        observer = _mock_observer(snapshot=snap)
        orch, _ = _build_orchestrator_with_observer(tmp_path, observer=observer)
        orch._brain.current_phase = "active"
        _run(orch.run_cycle())
        assert orch._brain.last_snapshot is not None
        assert orch._brain.last_snapshot["cpu_percent"] == 42.0

    def test_narrates_every_cycle(self, tmp_path: Path) -> None:
        """Orchestrator narrates observation report each cycle."""
        orch, mocks = _build_orchestrator_with_observer(tmp_path)
        orch._brain.current_phase = "active"
        _run(orch.run_cycle())
        # send_message should be called (for narration)
        assert mocks["supabase"].send_message.call_count >= 1

    def test_analyzes_when_changes_detected(self, tmp_path: Path) -> None:
        """LLM think_structured is called when diff has changes."""
        diff = SystemDiff(
            total_changes=3,
            severity="notable",
            new_processes=[{"name": "redis", "pid": 500}],
        )
        observer = _mock_observer(diff=diff)
        llm = _mock_llm()
        orch, _ = _build_orchestrator_with_observer(
            tmp_path, observer=observer, llm=llm,
        )
        orch._brain.current_phase = "active"
        _run(orch.run_cycle())
        # think_structured should be called for analysis
        llm.think_structured.assert_called()

    def test_skips_analysis_when_no_changes(self, tmp_path: Path) -> None:
        """LLM is NOT called when diff has zero changes and not 5th cycle."""
        diff = SystemDiff(total_changes=0, severity="normal")
        observer = _mock_observer(diff=diff)
        llm = _mock_llm()
        orch, _ = _build_orchestrator_with_observer(
            tmp_path, observer=observer, llm=llm,
        )
        orch._brain.current_phase = "active"
        orch._brain.cycle_count = 1  # Not a 5th cycle
        _run(orch.run_cycle())
        # think_structured should NOT be called (no changes, not 5th cycle)
        # Note: cycle_count is incremented in run_cycle to 2
        llm.think_structured.assert_not_called()


# ===========================================================================
# TestAgentSpinUp — agent activation / deactivation from observation
# ===========================================================================

class TestAgentSpinUp:
    def test_spins_up_agent_on_recommendation(self, tmp_path: Path) -> None:
        """When LLM recommends spinning up an agent, it gets activated."""
        builder = _mock_agent("builder")
        agents = {"discovery": _mock_agent(), "builder": builder}
        llm = _mock_llm()
        llm.think_structured = AsyncMock(return_value={
            "summary": "Found automation opportunity",
            "concerns": [],
            "opportunities": [],
            "recommended_actions": [{
                "type": "spin_up_agent",
                "agent": "builder",
                "task": {"type": "build_automation", "name": "test_auto"},
                "priority": "high",
                "reason": "New automation found",
            }],
        })

        diff = SystemDiff(total_changes=1, severity="notable")
        observer = _mock_observer(diff=diff)
        orch, mocks = _build_orchestrator_with_observer(
            tmp_path, agents=agents, llm=llm, observer=observer,
        )
        orch._brain.current_phase = "active"
        _run(orch.run_cycle())

        # Builder should have been activated
        builder.execute.assert_called_once()
        # Narration should mention the agent
        narrations = [
            call.args[2] for call in mocks["supabase"].send_message.call_args_list
            if len(call.args) >= 3
        ]
        assert any("builder" in n.lower() for n in narrations)

    def test_announces_agent_deactivation(self, tmp_path: Path) -> None:
        """Agent deactivation is narrated."""
        builder = _mock_agent("builder")
        agents = {"discovery": _mock_agent(), "builder": builder}
        llm = _mock_llm()
        llm.think_structured = AsyncMock(return_value={
            "summary": "ok",
            "concerns": [],
            "opportunities": [],
            "recommended_actions": [{
                "type": "spin_up_agent",
                "agent": "builder",
                "task": {"type": "test"},
                "reason": "test",
            }],
        })
        diff = SystemDiff(total_changes=1, severity="notable")
        observer = _mock_observer(diff=diff)
        orch, mocks = _build_orchestrator_with_observer(
            tmp_path, agents=agents, llm=llm, observer=observer,
        )
        orch._brain.current_phase = "active"
        _run(orch.run_cycle())

        narrations = [
            call.args[2] for call in mocks["supabase"].send_message.call_args_list
            if len(call.args) >= 3
        ]
        # Should have both "Spinning up" and "completed" messages
        assert any("spinning up" in n.lower() for n in narrations)
        assert any("completed" in n.lower() for n in narrations)

    def test_handles_agent_failure(self, tmp_path: Path) -> None:
        """If activated agent fails, it's narrated and cleaned up."""
        builder = _mock_agent("builder")
        builder.execute = AsyncMock(side_effect=RuntimeError("build exploded"))
        agents = {"discovery": _mock_agent(), "builder": builder}
        llm = _mock_llm()
        llm.think_structured = AsyncMock(return_value={
            "summary": "ok",
            "concerns": [],
            "opportunities": [],
            "recommended_actions": [{
                "type": "spin_up_agent",
                "agent": "builder",
                "task": {"type": "test"},
                "reason": "test",
            }],
        })
        diff = SystemDiff(total_changes=1, severity="notable")
        observer = _mock_observer(diff=diff)
        orch, mocks = _build_orchestrator_with_observer(
            tmp_path, agents=agents, llm=llm, observer=observer,
        )
        orch._brain.current_phase = "active"
        _run(orch.run_cycle())

        narrations = [
            call.args[2] for call in mocks["supabase"].send_message.call_args_list
            if len(call.args) >= 3
        ]
        assert any("failed" in n.lower() for n in narrations)
        # Session should be cleaned up
        assert len(orch._brain.active_agent_sessions) == 0


# ===========================================================================
# TestAlerts — severity-based alerting
# ===========================================================================

class TestAlerts:
    def test_alerts_on_severity_alert(self, tmp_path: Path) -> None:
        """Alert severity triggers alert narration."""
        diff = SystemDiff(
            total_changes=2,
            severity="alert",
            log_anomalies=[{"source": "/var/log/test", "line": "CRITICAL: DB down"}],
        )
        observer = _mock_observer(diff=diff)
        orch, mocks = _build_orchestrator_with_observer(tmp_path, observer=observer)
        orch._brain.current_phase = "active"
        _run(orch.run_cycle())

        narrations = [
            call.args[2] for call in mocks["supabase"].send_message.call_args_list
            if len(call.args) >= 3
        ]
        assert any("alert" in n.lower() for n in narrations)


# ===========================================================================
# TestSafeCommands — command safety
# ===========================================================================

class TestSafeCommands:
    def test_blocks_unsafe_command(self, tmp_path: Path) -> None:
        """Unsafe commands are blocked."""
        from vincera.core.orchestrator import _is_safe_command
        assert _is_safe_command(["ls", "/tmp"]) is True
        assert _is_safe_command(["rm", "-rf", "/"]) is False
        assert _is_safe_command(["cat", "/etc/passwd"]) is True
        assert _is_safe_command(["curl", "http://evil.com"]) is False
        assert _is_safe_command(["ls", "; rm -rf /"]) is False
        assert _is_safe_command(["ps", "aux"]) is True
        assert _is_safe_command(["df", "-h"]) is True
        assert _is_safe_command(["netstat", "-an"]) is True


# ===========================================================================
# TestBackwardCompat — OrchestratorState backward compatibility
# ===========================================================================

class TestBackwardCompat:
    def test_state_new_fields_default(self) -> None:
        """New fields have defaults, so old serialized states still load."""
        # Simulate loading an old state that doesn't have new fields
        old_state = {
            "current_phase": "active",
            "cycle_count": 10,
            "ranked_automations": [],
            "completed_tasks": [],
            "failed_tasks": [],
        }
        state = OrchestratorState(**old_state)
        assert state.last_snapshot is None
        assert state.last_diff_summary is None
        assert state.active_agent_sessions == []

    def test_save_brain_includes_system_health(self, tmp_path: Path) -> None:
        """When observer provides a snapshot, save_brain includes system_health."""
        snap = _snapshot(cpu_percent=33.0, memory_used_percent=66.0, process_count=42)
        observer = _mock_observer(snapshot=snap)
        orch, mocks = _build_orchestrator_with_observer(tmp_path, observer=observer)
        orch._brain.current_phase = "active"
        _run(orch.run_cycle())

        # Check what was saved to brain_state
        call_args = mocks["supabase"].save_brain_state.call_args
        saved_data = call_args[0][1]
        assert "system_health" in saved_data
        assert saved_data["system_health"]["cpu_percent"] == 33.0
        assert saved_data["system_health"]["process_count"] == 42

    def test_observation_data_in_context_for_response(self, tmp_path: Path) -> None:
        """User message context includes observation data."""
        snap = _snapshot(cpu_percent=50.0)
        observer = _mock_observer(snapshot=snap)
        orch, _ = _build_orchestrator_with_observer(tmp_path, observer=observer)
        orch._brain.current_phase = "active"
        # Run a cycle to populate brain snapshot
        _run(orch.run_cycle())

        context = orch._build_context_for_response()
        assert "CPU" in context or "cpu" in context.lower()

    def test_existing_phases_unchanged(self, tmp_path: Path) -> None:
        """Phase transitions still work with observer."""
        observer = _mock_observer()
        orch, _ = _build_orchestrator_with_observer(tmp_path, observer=observer)
        orch._brain.current_phase = "installing"
        result = _run(orch.run_cycle())
        assert result["action"] == "phase_transition"
        assert result["to"] == "discovering"

    def test_initialize_restores_observer_snapshot(self, tmp_path: Path) -> None:
        """On restart, observer.last_snapshot is restored from brain state."""
        sb = _mock_supabase()
        sb.get_latest_brain_state.return_value = {
            "current_phase": "active",
            "cycle_count": 5,
            "last_snapshot": {
                "timestamp": "2024-01-01T00:00:00+00:00",
                "cpu_percent": 30.0,
                "memory_used_percent": 50.0,
                "memory_available_gb": 8.0,
                "process_count": 10,
                "processes": [],
                "disk_usage": [],
                "scheduled_tasks": [],
                "watched_file_changes": [],
                "databases": [],
                "database_schemas": [],
                "network_shares": [],
                "recent_log_entries": [],
            },
        }
        observer = _mock_observer()
        orch, _ = _build_orchestrator_with_observer(
            tmp_path, supabase=sb, observer=observer,
        )
        _run(orch.initialize())
        # Observer should have had last_snapshot set
        assert observer.last_snapshot is not None
        assert observer.last_snapshot.cpu_percent == 30.0


# ===========================================================================
# TestDiffSummaryPersistence
# ===========================================================================

class TestDiffSummaryPersistence:
    def test_diff_summary_stored_in_brain(self, tmp_path: Path) -> None:
        """Diff summary is stored in brain for dashboard."""
        diff = SystemDiff(
            total_changes=5,
            severity="notable",
            new_processes=[{"name": "redis", "pid": 999}],
            modified_files=[{"name": "config.yaml", "path": "/etc/config.yaml"}],
            log_anomalies=[{"line": "WARNING: slow query"}],
        )
        observer = _mock_observer(diff=diff)
        orch, _ = _build_orchestrator_with_observer(tmp_path, observer=observer)
        orch._brain.current_phase = "active"
        _run(orch.run_cycle())

        ds = orch._brain.last_diff_summary
        assert ds is not None
        assert ds["total_changes"] == 5
        assert ds["severity"] == "notable"
        assert ds["new_processes"] == 1
        assert ds["modified_files"] == 1
        assert ds["log_anomalies"] == 1
