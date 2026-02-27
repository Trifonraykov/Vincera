"""Tests for vincera.core.orchestrator — Orchestrator."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch

import pytest

from vincera.core.orchestrator import Orchestrator, OrchestratorState


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    """Run an async coroutine synchronously."""
    return asyncio.run(coro)


def _mock_config(tmp_path: Path | None = None):
    config = MagicMock()
    home = (tmp_path or Path("/tmp/vincera_test")) / "VinceraHQ"
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
    llm.think_structured = AsyncMock(return_value={"opportunities": []})
    return llm


def _mock_ontology():
    ontology = MagicMock()
    mapping = MagicMock()
    mapping.model_dump.return_value = {"business_type": "ecommerce", "matched_domains": []}
    ontology.map_company.return_value = mapping
    ontology.suggest_automations.return_value = [
        {"name": "auto_invoice", "domain": "finance", "priority": "high", "evidence": "type match"},
    ]
    return ontology


def _mock_priority():
    from vincera.core.priority import AutomationCandidate, ScoredCandidate

    pe = MagicMock()
    candidate = AutomationCandidate(
        name="auto_invoice", domain="finance", description="Auto invoicing",
        source="ontology", evidence="type match", estimated_hours_saved_weekly=5.0,
    )
    scored = ScoredCandidate(
        candidate=candidate, impact_score=0.8, feasibility_score=0.9,
        risk_score=0.1, final_score=0.75, priority="high",
        scoring_breakdown={"impact": {}, "feasibility": {}, "risk": {}},
    )
    pe.merge_candidates.return_value = [candidate]
    pe.rank.return_value = [scored]
    pe.get_next_batch.return_value = [scored]
    pe.score.return_value = scored
    return pe


def _mock_authority():
    from vincera.core.authority import ActionRiskLevel, AuthorityDecision, AuthorityLevel

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


def _mock_verifier():
    verifier = MagicMock()
    return verifier


def _mock_agent(name: str = "discovery", status: str = "idle"):
    from vincera.agents.base import AgentStatus

    agent = MagicMock()
    agent.status = AgentStatus(status)
    agent.name = name
    agent.execute = AsyncMock(return_value={"result": "done"})
    agent.request_approval = AsyncMock(return_value="option_a")
    return agent


def _build_orchestrator(tmp_path: Path | None = None, **overrides):
    """Build Orchestrator with full mock suite. Returns (orchestrator, mocks_dict)."""
    config = overrides.pop("config", _mock_config(tmp_path))
    sb = overrides.pop("supabase", _mock_supabase())
    state = overrides.pop("state", _mock_state())
    llm = overrides.pop("llm", _mock_llm())
    ontology = overrides.pop("ontology", _mock_ontology())
    priority = overrides.pop("priority_engine", _mock_priority())
    authority = overrides.pop("authority", _mock_authority())
    ghost = overrides.pop("ghost_controller", _mock_ghost())
    verifier = overrides.pop("verifier", _mock_verifier())
    agents = overrides.pop("agents", {"discovery": _mock_agent("discovery")})

    orch = Orchestrator(
        config=config,
        llm=llm,
        supabase=sb,
        state=state,
        ontology=ontology,
        priority_engine=priority,
        authority=authority,
        ghost_controller=ghost,
        verifier=verifier,
        agents=agents,
    )

    mocks = {
        "config": config, "supabase": sb, "state": state, "llm": llm,
        "ontology": ontology, "priority_engine": priority, "authority": authority,
        "ghost_controller": ghost, "verifier": verifier, "agents": agents,
    }
    return orch, mocks


# ===========================================================================
# Initialize tests
# ===========================================================================

class TestInitialize:
    def test_fresh(self, tmp_path: Path) -> None:
        orch, mocks = _build_orchestrator(tmp_path)
        _run(orch.initialize())
        assert orch._brain.current_phase == "installing"

    def test_restore(self, tmp_path: Path) -> None:
        sb = _mock_supabase()
        sb.get_latest_brain_state.return_value = {
            "current_phase": "active",
            "cycle_count": 42,
        }
        orch, _ = _build_orchestrator(tmp_path, supabase=sb)
        _run(orch.initialize())
        assert orch._brain.current_phase == "active"
        assert orch._brain.cycle_count == 42


# ===========================================================================
# run_cycle tests
# ===========================================================================

class TestRunCycle:
    def test_when_paused(self, tmp_path: Path) -> None:
        state = _mock_state()
        state.is_paused.return_value = True
        orch, _ = _build_orchestrator(tmp_path, state=state)
        result = _run(orch.run_cycle())
        assert result["action"] == "paused"


# ===========================================================================
# Phase: install
# ===========================================================================

class TestPhaseInstall:
    def test_transitions(self, tmp_path: Path) -> None:
        orch, mocks = _build_orchestrator(tmp_path)
        orch._brain.current_phase = "installing"
        result = _run(orch.run_cycle())
        assert result["action"] == "phase_transition"
        assert result["to"] == "discovering"
        assert orch._brain.current_phase == "discovering"


# ===========================================================================
# Phase: discover
# ===========================================================================

class TestPhaseDiscover:
    def test_runs_agent(self, tmp_path: Path) -> None:
        agent = _mock_agent("discovery", "idle")
        orch, _ = _build_orchestrator(tmp_path, agents={"discovery": agent})
        orch._brain.current_phase = "discovering"
        _run(orch.run_cycle())
        agent.execute.assert_called_once()

    def test_transitions(self, tmp_path: Path) -> None:
        orch, _ = _build_orchestrator(tmp_path)
        orch._brain.current_phase = "discovering"
        result = _run(orch.run_cycle())
        assert result["to"] == "researching"
        assert orch._brain.current_phase == "researching"


# ===========================================================================
# Phase: research
# ===========================================================================

class TestPhaseResearch:
    def test_skips_if_no_agent(self, tmp_path: Path) -> None:
        orch, _ = _build_orchestrator(tmp_path, agents={"discovery": _mock_agent()})
        orch._brain.current_phase = "researching"
        result = _run(orch.run_cycle())
        assert result["to"] == "ghost"
        assert "unavailable" in result.get("note", "") or "skipped" in result.get("note", "")

    def test_runs_agent(self, tmp_path: Path) -> None:
        research_agent = _mock_agent("research", "idle")
        agents = {"discovery": _mock_agent(), "research": research_agent}
        orch, _ = _build_orchestrator(tmp_path, agents=agents)
        orch._brain.current_phase = "researching"
        orch._brain.company_model = {
            "business_type": "ecommerce", "industry": "retail", "confidence": 0.8,
            "software_stack": [], "data_architecture": [], "detected_processes": [],
            "automation_opportunities": [], "pain_points": [], "risk_areas": [],
            "key_findings": [],
        }
        _run(orch.run_cycle())
        research_agent.execute.assert_called_once()

    def test_builds_mapping(self, tmp_path: Path) -> None:
        agents = {"discovery": _mock_agent(), "research": _mock_agent("research", "idle")}
        orch, mocks = _build_orchestrator(tmp_path, agents=agents)
        orch._brain.current_phase = "researching"
        orch._brain.company_model = {
            "business_type": "ecommerce", "industry": "retail", "confidence": 0.8,
            "software_stack": [], "data_architecture": [], "detected_processes": [],
            "automation_opportunities": [], "pain_points": [], "risk_areas": [],
            "key_findings": [],
        }
        _run(orch.run_cycle())
        assert orch._brain.ontology_mapping is not None


# ===========================================================================
# Phase: ghost
# ===========================================================================

class TestPhaseGhost:
    def test_starts(self, tmp_path: Path) -> None:
        ghost = _mock_ghost()
        ghost.is_active = False
        ghost.start_date = None
        ghost.should_end = AsyncMock(return_value=False)
        orch, _ = _build_orchestrator(tmp_path, ghost_controller=ghost)
        orch._brain.current_phase = "ghost"
        result = _run(orch.run_cycle())
        assert result["action"] == "ghost_started"
        ghost.start.assert_called_once()

    def test_observing(self, tmp_path: Path) -> None:
        ghost = _mock_ghost()
        ghost.is_active = True
        ghost.days_remaining = 3
        orch, _ = _build_orchestrator(tmp_path, ghost_controller=ghost)
        orch._brain.current_phase = "ghost"
        result = _run(orch.run_cycle())
        assert result["action"] == "observing"

    def test_ends(self, tmp_path: Path) -> None:
        ghost = _mock_ghost()
        ghost.is_active = False
        ghost.start_date = "2024-01-01"
        ghost.should_end = AsyncMock(return_value=True)
        orch, _ = _build_orchestrator(tmp_path, ghost_controller=ghost)
        orch._brain.current_phase = "ghost"
        result = _run(orch.run_cycle())
        assert result["to"] == "active"
        ghost.end.assert_called_once()


# ===========================================================================
# Phase: active
# ===========================================================================

class TestPhaseActive:
    def test_blocked_by_authority(self, tmp_path: Path) -> None:
        auth = _mock_authority()
        auth.can_act.return_value = False
        orch, _ = _build_orchestrator(tmp_path, authority=auth)
        orch._brain.current_phase = "active"
        result = _run(orch.run_cycle())
        assert result["action"] == "blocked"

    def test_assigns_task(self, tmp_path: Path) -> None:
        agents = {"discovery": _mock_agent(), "builder": _mock_agent("builder")}
        orch, _ = _build_orchestrator(tmp_path, agents=agents)
        orch._brain.current_phase = "active"
        from vincera.core.priority import AutomationCandidate, ScoredCandidate
        candidate = AutomationCandidate(
            name="auto_invoice", domain="finance", description="Auto invoicing",
            source="ontology", evidence="match", estimated_hours_saved_weekly=5.0,
        )
        scored = ScoredCandidate(
            candidate=candidate, impact_score=0.8, feasibility_score=0.9,
            risk_score=0.1, final_score=0.75, priority="high",
            scoring_breakdown={},
        )
        orch._brain.ranked_automations = [scored.model_dump()]
        result = _run(orch.run_cycle())
        assert result["action"] in ("task_assigned", "task_completed")
        assert result["agent"] == "builder"

    def test_denied(self, tmp_path: Path) -> None:
        auth = _mock_authority()
        auth.request_if_needed = AsyncMock(return_value=False)
        agents = {"discovery": _mock_agent(), "builder": _mock_agent("builder")}
        orch, _ = _build_orchestrator(tmp_path, agents=agents, authority=auth)
        orch._brain.current_phase = "active"
        from vincera.core.priority import AutomationCandidate, ScoredCandidate
        candidate = AutomationCandidate(
            name="auto_invoice", domain="finance", description="Auto invoicing",
            source="ontology", evidence="match",
        )
        scored = ScoredCandidate(
            candidate=candidate, impact_score=0.8, feasibility_score=0.9,
            risk_score=0.1, final_score=0.75, priority="high",
            scoring_breakdown={},
        )
        orch._brain.ranked_automations = [scored.model_dump()]
        result = _run(orch.run_cycle())
        assert result["action"] == "task_denied"

    def test_no_backlog(self, tmp_path: Path) -> None:
        pe = _mock_priority()
        pe.merge_candidates.return_value = []
        pe.rank.return_value = []
        pe.get_next_batch.return_value = []
        orch, _ = _build_orchestrator(tmp_path, priority_engine=pe)
        orch._brain.current_phase = "active"
        orch._brain.ranked_automations = []
        result = _run(orch.run_cycle())
        assert result["action"] == "idle"


# ===========================================================================
# Post-completion operations
# ===========================================================================

class TestPostCompletion:
    def test_queues_operator_after_builder(self, tmp_path: Path) -> None:
        agents = {
            "discovery": _mock_agent(),
            "builder": _mock_agent("builder"),
            "operator": _mock_agent("operator"),
        }
        builder_result = {
            "status": "success",
            "deployment_id": "dep-123",
            "script_path": None,
        }
        agents["builder"].execute = AsyncMock(return_value=builder_result)
        orch, _ = _build_orchestrator(tmp_path, agents=agents)
        orch._brain.current_phase = "active"

        from vincera.core.priority import AutomationCandidate, ScoredCandidate
        candidate = AutomationCandidate(
            name="auto_invoice", domain="finance", description="invoicing",
            source="ontology", evidence="match", estimated_hours_saved_weekly=5.0,
        )
        scored = ScoredCandidate(
            candidate=candidate, impact_score=0.8, feasibility_score=0.9,
            risk_score=0.1, final_score=0.75, priority="high",
            scoring_breakdown={},
        )
        orch._brain.ranked_automations = [scored.model_dump()]
        result = _run(orch.run_cycle())
        assert result["action"] == "task_completed"
        assert any(
            op["type"] == "operator_canary" for op in orch._brain.pending_operations
        )

    def test_queues_unstuck_on_failure(self, tmp_path: Path) -> None:
        agents = {
            "discovery": _mock_agent(),
            "builder": _mock_agent("builder"),
            "unstuck": _mock_agent("unstuck"),
        }
        agents["builder"].execute = AsyncMock(side_effect=RuntimeError("build failed"))
        orch, _ = _build_orchestrator(tmp_path, agents=agents)
        orch._brain.current_phase = "active"

        from vincera.core.priority import AutomationCandidate, ScoredCandidate
        candidate = AutomationCandidate(
            name="test_task", domain="finance", description="test",
            source="ontology", evidence="match",
        )
        scored = ScoredCandidate(
            candidate=candidate, impact_score=0.5, feasibility_score=0.5,
            risk_score=0.1, final_score=0.5, priority="medium",
            scoring_breakdown={},
        )
        orch._brain.ranked_automations = [scored.model_dump()]
        result = _run(orch.run_cycle())
        assert result["action"] == "task_failed"
        assert any(
            op["type"] == "unstuck_diagnosis" for op in orch._brain.pending_operations
        )

    def test_dispatches_pending_ops(self, tmp_path: Path) -> None:
        operator = _mock_agent("operator")
        agents = {"discovery": _mock_agent(), "operator": operator}
        orch, _ = _build_orchestrator(tmp_path, agents=agents)
        orch._brain.current_phase = "active"
        orch._brain.pending_operations = [{
            "type": "operator_canary",
            "agent": "operator",
            "description": "Run canary for test",
            "task": {
                "type": "run_canary",
                "deployment_id": "dep-1",
                "script": "",
                "automation_name": "test",
            },
        }]
        result = _run(orch.run_cycle())
        assert result["action"] == "operation_completed"
        operator.execute.assert_called_once()


# ===========================================================================
# Sensitivity detection
# ===========================================================================

class TestSensitivity:
    def test_financial_data(self) -> None:
        from vincera.core.priority import AutomationCandidate
        candidate = AutomationCandidate(
            name="payroll", domain="finance", description="process payroll",
            source="ontology", evidence="test",
            affects_financial_data=True,
        )
        is_sensitive, reason = Orchestrator._detect_sensitivity(candidate)
        assert is_sensitive
        assert "financial" in reason

    def test_customer_data(self) -> None:
        from vincera.core.priority import AutomationCandidate
        candidate = AutomationCandidate(
            name="emails", domain="sales", description="send emails",
            source="ontology", evidence="test",
            affects_customer_data=True,
        )
        is_sensitive, reason = Orchestrator._detect_sensitivity(candidate)
        assert is_sensitive
        assert "customer" in reason

    def test_safe_task(self) -> None:
        from vincera.core.priority import AutomationCandidate
        candidate = AutomationCandidate(
            name="report", domain="general", description="generate report",
            source="ontology", evidence="test",
        )
        is_sensitive, _ = Orchestrator._detect_sensitivity(candidate)
        assert not is_sensitive


# ===========================================================================
# Continuous improvement
# ===========================================================================

class TestContinuousImprovement:
    def test_triggers_when_backlog_empty(self, tmp_path: Path) -> None:
        agents = {"discovery": _mock_agent(), "builder": _mock_agent("builder")}
        orch, _ = _build_orchestrator(tmp_path, agents=agents)
        orch._brain.current_phase = "active"
        orch._brain.ranked_automations = []
        orch._brain.completed_tasks = [{"name": "done_task", "status": "completed"}]
        orch._brain.last_discovery_at = "2099-01-01T00:00:00+00:00"
        orch._brain.last_analysis_at = "2099-01-01T00:00:00+00:00"
        orch._brain.last_training_at = "2099-01-01T00:00:00+00:00"
        orch._brain.last_opportunity_scan_at = "2099-01-01T00:00:00+00:00"
        result = _run(orch.run_cycle())
        assert result["action"] == "monitoring"

    def test_triggers_discovery_when_due(self, tmp_path: Path) -> None:
        discovery = _mock_agent("discovery")
        agents = {"discovery": discovery}
        orch, _ = _build_orchestrator(tmp_path, agents=agents)
        orch._brain.current_phase = "active"
        orch._brain.ranked_automations = []
        orch._brain.completed_tasks = [{"name": "x", "status": "completed"}]
        orch._brain.last_discovery_at = "2020-01-01T00:00:00+00:00"
        result = _run(orch.run_cycle())
        assert result["action"] == "discovery_complete"
        discovery.execute.assert_called_once()


# ===========================================================================
# Backlog
# ===========================================================================

class TestBacklog:
    def test_build_initial_backlog(self, tmp_path: Path) -> None:
        orch, mocks = _build_orchestrator(tmp_path)
        orch._brain.ontology_mapping = {"business_type": "ecommerce", "matched_domains": []}
        orch._brain.company_model = {
            "business_type": "ecommerce", "industry": "retail", "confidence": 0.8,
            "software_stack": [], "data_architecture": [], "detected_processes": [],
            "automation_opportunities": [{"name": "auto_invoice", "description": "invoicing"}],
            "pain_points": [], "risk_areas": [], "key_findings": [],
        }
        _run(orch._build_initial_backlog())
        assert len(orch._brain.ranked_automations) > 0
        mocks["supabase"].send_message.assert_called()


# ===========================================================================
# User messages
# ===========================================================================

class TestUserMessages:
    def test_status(self, tmp_path: Path) -> None:
        orch, mocks = _build_orchestrator(tmp_path)
        _run(orch.handle_user_message("what are you doing"))
        mocks["supabase"].send_message.assert_called()

    def test_pause(self, tmp_path: Path) -> None:
        orch, mocks = _build_orchestrator(tmp_path)
        _run(orch.handle_user_message("pause"))
        mocks["state"].set_paused.assert_called_with(True)


# ===========================================================================
# Helpers
# ===========================================================================

class TestHelpers:
    def test_save_brain(self, tmp_path: Path) -> None:
        orch, mocks = _build_orchestrator(tmp_path)
        _run(orch._save_brain())
        mocks["supabase"].save_brain_state.assert_called_once()
        call_args = mocks["supabase"].save_brain_state.call_args
        assert call_args[0][0] == "comp-1"

    def test_select_agent(self, tmp_path: Path) -> None:
        from vincera.core.priority import AutomationCandidate, ScoredCandidate
        orch, _ = _build_orchestrator(tmp_path)
        candidate = AutomationCandidate(
            name="test", domain="finance", description="test",
            source="ontology", evidence="test",
        )
        scored = ScoredCandidate(
            candidate=candidate, impact_score=0.5, feasibility_score=0.5,
            risk_score=0.1, final_score=0.5, priority="medium",
            scoring_breakdown={},
        )
        assert orch._select_agent(scored) == "builder"
