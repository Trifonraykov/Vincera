"""End-to-end integration tests — 7 core lifecycle scenarios + 3 bonus tests.

Each test wires real classes together (Orchestrator, MessageHandler,
GhostModeController, MessagePoller) with mock I/O boundaries (Supabase, LLM).
No network calls, no real database — fast and deterministic.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from vincera.agents.base import AgentStatus
from vincera.core.ghost_mode import GhostModeController
from vincera.core.message_handler import MessageHandler
from vincera.core.message_poller import MessagePoller
from vincera.core.orchestrator import Orchestrator


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    """Run an async coroutine synchronously."""
    return asyncio.run(coro)


def _mock_agent(name: str = "discovery", status: str = "idle") -> MagicMock:
    """Create a mock agent with standard interface."""
    agent = MagicMock()
    agent.status = AgentStatus(status)
    agent.name = name
    agent.execute = AsyncMock(return_value={"result": "done"})
    agent.handle_message = AsyncMock(return_value="ok")
    agent.request_approval = AsyncMock(return_value="option_a")
    return agent


def _mock_ontology() -> MagicMock:
    ontology = MagicMock()
    mapping = MagicMock()
    mapping.model_dump.return_value = {"business_type": "ecommerce", "matched_domains": []}
    ontology.map_company.return_value = mapping
    ontology.suggest_automations.return_value = [
        {"name": "auto_invoice", "domain": "finance", "priority": "high", "evidence": "type match"},
    ]
    return ontology


def _mock_priority() -> MagicMock:
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
    return pe


def _mock_authority() -> MagicMock:
    from vincera.core.authority import ActionRiskLevel

    auth = MagicMock()
    auth.can_act.return_value = True
    auth.classify_risk.return_value = ActionRiskLevel.LOW
    auth.request_if_needed = AsyncMock(return_value=True)
    auth.get_restrictions_summary.return_value = "No restrictions"
    return auth


def _mock_corrections() -> MagicMock:
    corrections = MagicMock()
    corrections.record_correction = AsyncMock()
    return corrections


def _build_full_system(
    tmp_path: Path,
    mock_supabase: MagicMock,
    mock_llm: MagicMock,
    mock_state: MagicMock,
    *,
    use_real_ghost: bool = False,
    agents: dict | None = None,
    mock_config: MagicMock | None = None,
) -> tuple:
    """Wire real Orchestrator + MessageHandler + optionally real GhostModeController.

    Returns (orchestrator, handler, ghost, mocks_dict).
    """
    config = mock_config or MagicMock()
    if not mock_config:
        home = tmp_path / "VinceraHQ"
        home.mkdir(parents=True, exist_ok=True)
        (home / "knowledge").mkdir(parents=True, exist_ok=True)
        config.home_dir = home
        config.company_id = "comp-1"
        config.company_name = "TestCorp"
        config.agent_name = "test-agent"
        config.ghost_mode_days = 7

    ontology = _mock_ontology()
    priority = _mock_priority()
    authority = _mock_authority()
    verifier = MagicMock()

    if use_real_ghost:
        ghost = GhostModeController(supabase=mock_supabase, config=config)
    else:
        ghost = MagicMock()
        ghost.is_active = False
        ghost.start_date = None
        ghost.days_remaining = 0
        ghost.start = AsyncMock()
        ghost.should_end = AsyncMock(return_value=True)
        ghost.end = AsyncMock()

    if agents is None:
        agents = {"discovery": _mock_agent("discovery")}

    orch = Orchestrator(
        config=config,
        llm=mock_llm,
        supabase=mock_supabase,
        state=mock_state,
        ontology=ontology,
        priority_engine=priority,
        authority=authority,
        ghost_controller=ghost,
        verifier=verifier,
        agents=agents,
    )

    corrections = _mock_corrections()

    handler = MessageHandler(
        orchestrator=orch,
        agents=agents,
        corrections=corrections,
        supabase=mock_supabase,
        company_id=config.company_id,
    )

    mocks = {
        "config": config,
        "supabase": mock_supabase,
        "state": mock_state,
        "llm": mock_llm,
        "ontology": ontology,
        "priority_engine": priority,
        "authority": authority,
        "ghost_controller": ghost,
        "verifier": verifier,
        "agents": agents,
        "corrections": corrections,
    }

    return orch, handler, ghost, mocks


# ===========================================================================
# Test 1: Agent Startup Lifecycle
# ===========================================================================

class TestAgentStartupLifecycle:
    """Verify fresh startup: initialize → installing phase → brain saved."""

    def test_fresh_startup(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        orch, _, _, mocks = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
        )
        _run(orch.initialize())

        # Fresh state — no brain in Supabase → starts at "installing"
        assert orch._brain.current_phase == "installing"

    def test_restored_startup(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        mock_supabase.get_latest_brain_state.return_value = {
            "current_phase": "active",
            "cycle_count": 42,
        }
        orch, _, _, _ = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
        )
        _run(orch.initialize())

        assert orch._brain.current_phase == "active"
        assert orch._brain.cycle_count == 42
        mock_supabase.send_message.assert_called()


# ===========================================================================
# Test 2: Discovery Narration Flow
# ===========================================================================

class TestDiscoveryNarrationFlow:
    """Verify discovery agent executes and phase transitions to researching."""

    def test_discovery_runs_and_transitions(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        discovery = _mock_agent("discovery", "idle")
        orch, _, _, _ = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
            agents={"discovery": discovery},
        )
        orch._brain.current_phase = "discovering"

        result = _run(orch.run_cycle())

        discovery.execute.assert_called_once()
        assert result["action"] == "phase_transition"
        assert result["to"] == "researching"
        assert orch._brain.current_phase == "researching"
        mock_supabase.save_brain_state.assert_called()


# ===========================================================================
# Test 3: Ghost Mode Activation
# ===========================================================================

class TestGhostModeActivation:
    """Verify real GhostModeController starts, is active, notifies Supabase."""

    def test_ghost_starts(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        orch, _, ghost, _ = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
            use_real_ghost=True,
        )
        orch._brain.current_phase = "ghost"

        result = _run(orch.run_cycle())

        assert result["action"] == "ghost_started"
        assert ghost.is_active is True
        assert ghost.days_remaining > 0

        # Supabase should be notified
        mock_supabase.update_company.assert_called()
        update_args = mock_supabase.update_company.call_args
        assert update_args[0][1]["status"] == "ghost"

        # Chat announcement sent
        mock_supabase.send_message.assert_called()


# ===========================================================================
# Test 4: User Chat Routing
# ===========================================================================

class TestUserChatRouting:
    """Verify MessageHandler routes messages correctly."""

    def test_routes_to_builder(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        builder = _mock_agent("builder", "idle")
        agents = {"discovery": _mock_agent("discovery"), "builder": builder}
        _, handler, _, _ = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
            agents=agents,
        )

        _run(handler.handle({
            "content": "build me an invoice tool",
            "sender": "user",
            "message_type": "chat",
        }))

        builder.handle_message.assert_called_once_with("build me an invoice tool")

    def test_routes_status_to_orchestrator(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        orch, handler, _, _ = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
        )

        _run(handler.handle({
            "content": "what's the status",
            "sender": "user",
            "message_type": "chat",
        }))

        # Status command triggers orchestrator.handle_user_message via system command
        mock_supabase.send_message.assert_called()

    def test_routes_correction(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        _, handler, _, mocks = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
        )

        _run(handler.handle({
            "content": "that's wrong, fix it",
            "sender": "user",
            "message_type": "chat",
        }))

        mocks["corrections"].record_correction.assert_called_once()

    def test_ignores_system_sender(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        builder = _mock_agent("builder", "idle")
        agents = {"discovery": _mock_agent("discovery"), "builder": builder}
        _, handler, _, mocks = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
            agents=agents,
        )

        # Reset call counts
        mock_supabase.send_message.reset_mock()

        _run(handler.handle({
            "content": "build something",
            "sender": "system",
            "message_type": "chat",
        }))

        # Should be ignored entirely — no agent calls, no supabase messages
        builder.handle_message.assert_not_called()
        mocks["corrections"].record_correction.assert_not_called()


# ===========================================================================
# Test 5: Decision Lifecycle
# ===========================================================================

class TestDecisionLifecycle:
    """Verify decision_response messages resolve decisions in Supabase."""

    def test_resolves_decision(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        _, handler, _, _ = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
        )

        _run(handler.handle({
            "content": "",
            "sender": "user",
            "message_type": "decision_response",
            "metadata": {
                "decision_id": "dec-abc",
                "resolution": "option_a",
            },
        }))

        mock_supabase.resolve_decision.assert_called_once_with("dec-abc", "option_a")


# ===========================================================================
# Test 6: Ghost Report Generation
# ===========================================================================

class TestGhostReportGeneration:
    """Verify real GhostModeController generates daily reports correctly."""

    def test_generates_report(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        _, _, ghost, _ = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
            use_real_ghost=True,
        )

        # Start ghost mode
        _run(ghost.start("comp-1", days=7))

        # Add observations
        _run(ghost.observe_process(
            "comp-1", "processed invoices manually", "invoice data",
            estimated_time_minutes=30.0, frequency="daily",
        ))
        _run(ghost.observe_process(
            "comp-1", "copied data between spreadsheets", "sales data",
            estimated_time_minutes=15.0, frequency="daily",
        ))

        # Add would-have automation
        _run(ghost.would_have_automated(
            "comp-1", "auto_invoice", "Automatic invoice processing",
            estimated_hours_saved=5.0, complexity="medium",
        ))

        # Generate report
        report = _run(ghost.generate_daily_report("comp-1"))

        assert len(report["observed_processes"]) == 2
        assert len(report["would_have_automated"]) == 1
        assert report["estimated_hours_saved"] == 5.0

        mock_supabase.save_ghost_report.assert_called_once()
        # Narration message sent
        assert mock_supabase.send_message.call_count >= 2  # start + report


# ===========================================================================
# Test 7: Orchestrator OODA Full Cycle
# ===========================================================================

class TestOrchestratorOODAFullCycle:
    """Verify orchestrator transitions through all phases: install → discover → research → ghost → active."""

    def test_full_phase_sequence(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        discovery = _mock_agent("discovery", "idle")
        agents = {"discovery": discovery}
        orch, _, ghost, mocks = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
            agents=agents,
        )

        # Phase 1: installing → discovering
        orch._brain.current_phase = "installing"
        result = _run(orch.run_cycle())
        assert result["to"] == "discovering"

        # Phase 2: discovering → researching
        result = _run(orch.run_cycle())
        assert result["to"] == "researching"
        discovery.execute.assert_called_once()

        # Phase 3: researching → ghost (no research agent → skip)
        result = _run(orch.run_cycle())
        assert result["to"] == "ghost"

        # Phase 4: ghost → starts ghost mode
        result = _run(orch.run_cycle())
        assert result["action"] == "ghost_started"
        ghost.start.assert_called_once()

        # Simulate ghost ending
        ghost.is_active = False
        ghost.start_date = "2024-01-01"
        ghost.should_end = AsyncMock(return_value=True)

        result = _run(orch.run_cycle())
        assert result["to"] == "active"
        assert orch._brain.current_phase == "active"

        # Brain saved at each transition
        assert mock_supabase.save_brain_state.call_count >= 4


# ===========================================================================
# Test 8 (Bonus): Message Poller Dispatches
# ===========================================================================

class TestMessagePollerDispatches:
    """Verify MessagePoller calls handler.handle() for new messages."""

    def test_poll_dispatches(self, mock_supabase: MagicMock) -> None:
        mock_handler = MagicMock()
        mock_handler.handle = AsyncMock()

        mock_supabase.get_new_messages.return_value = [
            {
                "id": "msg-1",
                "content": "hello",
                "sender": "user",
                "message_type": "chat",
                "created_at": "2024-01-01T00:00:00Z",
            }
        ]

        poller = MessagePoller(
            handler=mock_handler,
            supabase=mock_supabase,
            company_id="comp-1",
        )

        count = _run(poller._poll_once())

        assert count == 1
        mock_handler.handle.assert_called_once()
        assert poller.messages_processed == 1

    def test_poll_empty(self, mock_supabase: MagicMock) -> None:
        mock_handler = MagicMock()
        mock_handler.handle = AsyncMock()
        mock_supabase.get_new_messages.return_value = []

        poller = MessagePoller(
            handler=mock_handler,
            supabase=mock_supabase,
            company_id="comp-1",
        )

        count = _run(poller._poll_once())

        assert count == 0
        mock_handler.handle.assert_not_called()


# ===========================================================================
# Test 9 (Bonus): Ghost Mode End Summary
# ===========================================================================

class TestGhostModeEndSummary:
    """Verify ghost.end() sends summary and resets state."""

    def test_end_sends_summary(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        _, _, ghost, _ = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
            use_real_ghost=True,
        )

        # Start ghost mode
        _run(ghost.start("comp-1", days=7))

        # Pre-populate reports for the summary
        mock_supabase.get_ghost_reports.return_value = [
            {
                "estimated_hours_saved": 3.0,
                "estimated_tasks_automated": 2,
                "would_have_automated": [
                    {"automation_name": "auto_invoice", "estimated_hours_saved": 3.0},
                ],
            },
            {
                "estimated_hours_saved": 5.0,
                "estimated_tasks_automated": 1,
                "would_have_automated": [
                    {"automation_name": "auto_report", "estimated_hours_saved": 5.0},
                ],
            },
            {
                "estimated_hours_saved": 2.0,
                "estimated_tasks_automated": 1,
                "would_have_automated": [
                    {"automation_name": "auto_email", "estimated_hours_saved": 2.0},
                ],
            },
        ]

        # Reset to track end-specific calls
        mock_supabase.send_message.reset_mock()
        mock_supabase.update_company.reset_mock()

        _run(ghost.end("comp-1"))

        # Summary sent
        mock_supabase.send_message.assert_called()
        summary_call = mock_supabase.send_message.call_args
        assert "ghost_mode" in summary_call[0][1]

        # Company status updated to active
        mock_supabase.update_company.assert_called()
        update_call = mock_supabase.update_company.call_args
        assert update_call[0][1]["status"] == "active"

        # Ghost mode is no longer active
        assert ghost.is_active is False


# ===========================================================================
# Test 10 (Bonus): Pause / Resume Blocks Cycle
# ===========================================================================

class TestPauseResumeBlocksCycle:
    """Verify orchestrator respects pause state."""

    def test_paused_blocks_cycle(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        mock_state.is_paused.return_value = True
        orch, _, _, _ = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
        )

        result = _run(orch.run_cycle())
        assert result["action"] == "paused"

    def test_resumed_allows_cycle(
        self, tmp_path: Path, mock_supabase: MagicMock,
        mock_llm: MagicMock, mock_state: MagicMock,
    ) -> None:
        mock_state.is_paused.return_value = False
        orch, _, _, _ = _build_full_system(
            tmp_path, mock_supabase, mock_llm, mock_state,
        )
        orch._brain.current_phase = "installing"

        result = _run(orch.run_cycle())
        assert result["action"] != "paused"
        assert result["action"] == "phase_transition"
