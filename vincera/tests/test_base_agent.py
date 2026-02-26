"""Tests for vincera.agents.base and vincera.knowledge.playbook."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ============================================================
# Helpers
# ============================================================


def _run(coro):
    """Run an async coroutine synchronously."""
    return asyncio.run(coro)


def _mock_llm():
    """Create a mock OpenRouterClient."""
    llm = MagicMock()
    llm.think = AsyncMock(return_value="I'm the discovery agent. Currently idle.")
    llm.think_structured = AsyncMock(return_value={"tags": ["deploy", "service", "production"]})
    return llm


def _mock_supabase():
    """Create a mock SupabaseManager."""
    sb = MagicMock()
    sb._company_id = "comp-123"
    sb.send_message.return_value = {"id": "msg-1"}
    sb.create_decision.return_value = "dec-123"
    sb.poll_decision.return_value = {"id": "dec-123", "status": "resolved", "chosen_option": "option_a"}
    sb.add_playbook_entry.return_value = {"id": "pb-1"}
    sb.query_playbook.return_value = [
        {"action_type": "deploy", "success": True, "similarity_tags": ["deploy", "service"]},
    ]
    sb.query_knowledge.return_value = []
    sb.log_event.return_value = {"id": "ev-1"}
    return sb


def _mock_state(tmp_path: Path):
    """Create a mock GlobalState."""
    state = MagicMock()
    state.add_action = MagicMock()
    state.update_agent_status = MagicMock()
    state.get_agent_status.return_value = {"agent_name": "discovery", "status": "idle", "current_task": "none"}
    state._db = MagicMock()
    state._db.query.return_value = [
        {"agent_name": "discovery", "action_type": "scan", "target": "/etc", "result": "ok", "created_at": "2025-01-01T00:00:00Z"},
    ]
    return state


def _mock_verifier():
    """Create a mock Verifier."""
    from vincera.verification.verifier import CheckResult, VerificationResult

    verifier = MagicMock()
    verifier.verify = AsyncMock(return_value=VerificationResult(
        passed=True,
        checks=[CheckResult(name="test", passed=True, reason="ok")],
        confidence=0.95,
        blocked_reason=None,
    ))
    return verifier


def _mock_settings(tmp_path: Path):
    """Create a mock VinceraSettings."""
    settings = MagicMock()
    settings.home_dir = tmp_path / "VinceraHQ"
    settings.home_dir.mkdir(parents=True, exist_ok=True)
    (settings.home_dir / "agents").mkdir(parents=True, exist_ok=True)
    settings.company_name = "TestCorp"
    settings.agent_name = "vincera"
    return settings


def _make_concrete_agent(tmp_path: Path, **overrides):
    """Create a ConcreteAgent (test subclass of BaseAgent)."""
    from vincera.agents.base import BaseAgent

    class ConcreteAgent(BaseAgent):
        async def run(self, task: dict) -> dict:
            return {"result": "done", "task": task}

    defaults = dict(
        name="discovery",
        company_id="comp-123",
        config=_mock_settings(tmp_path),
        llm=_mock_llm(),
        supabase=_mock_supabase(),
        state=_mock_state(tmp_path),
        verifier=_mock_verifier(),
    )
    defaults.update(overrides)
    return ConcreteAgent(**defaults)


class _FailingAgent:
    """Agent whose run() raises."""
    pass


def _make_failing_agent(tmp_path: Path):
    """Create a test agent that raises on run()."""
    from vincera.agents.base import BaseAgent

    class FailingAgent(BaseAgent):
        async def run(self, task: dict) -> dict:
            raise RuntimeError("Something went wrong")

    return FailingAgent(
        name="failing",
        company_id="comp-123",
        config=_mock_settings(tmp_path),
        llm=_mock_llm(),
        supabase=_mock_supabase(),
        state=_mock_state(tmp_path),
        verifier=_mock_verifier(),
    )


# ============================================================
# Handle message (chat)
# ============================================================


class TestHandleMessage:
    def test_returns_string(self, tmp_path: Path) -> None:
        agent = _make_concrete_agent(tmp_path)
        response = _run(agent.handle_message("What are you doing?"))
        assert isinstance(response, str)
        assert len(response) > 0

    def test_sends_to_supabase(self, tmp_path: Path) -> None:
        sb = _mock_supabase()
        agent = _make_concrete_agent(tmp_path, supabase=sb)
        _run(agent.handle_message("Hello"))
        sb.send_message.assert_called_once()
        call_kwargs = sb.send_message.call_args
        assert call_kwargs[0][0] == "comp-123"  # company_id
        assert call_kwargs[0][1] == "discovery"  # agent_name


# ============================================================
# Playbook
# ============================================================


class TestPlaybook:
    def test_consult_delegates(self, tmp_path: Path) -> None:
        agent = _make_concrete_agent(tmp_path)
        results = _run(agent.consult_playbook("deploy service-x"))
        assert isinstance(results, list)

    def test_record_delegates(self, tmp_path: Path) -> None:
        sb = _mock_supabase()
        agent = _make_concrete_agent(tmp_path, supabase=sb)
        _run(agent.record_to_playbook(
            action_type="deploy",
            context="Deploy service-x",
            approach="Rolling update",
            outcome="Success",
            success=True,
            lessons="Use canary first",
        ))
        sb.add_playbook_entry.assert_called_once()


# ============================================================
# Log action
# ============================================================


class TestLogAction:
    def test_writes_to_state(self, tmp_path: Path) -> None:
        state = _mock_state(tmp_path)
        agent = _make_concrete_agent(tmp_path, state=state)
        _run(agent.log_action("scan", "/etc/hosts", "found 3 entries"))
        state.add_action.assert_called_once_with("discovery", "scan", "/etc/hosts", "found 3 entries", None)


# ============================================================
# Request approval
# ============================================================


class TestRequestApproval:
    def test_creates_decision(self, tmp_path: Path) -> None:
        sb = _mock_supabase()
        agent = _make_concrete_agent(tmp_path, supabase=sb)
        result = _run(agent.request_approval(
            question="Deploy to production?",
            option_a="Yes",
            option_b="No",
            context="All tests pass",
            risk_level="medium",
        ))
        sb.create_decision.assert_called_once()
        assert result == "option_a"

    def test_polls_until_resolved(self, tmp_path: Path) -> None:
        sb = _mock_supabase()
        # First call returns pending, second returns resolved
        sb.poll_decision.side_effect = [
            {"id": "dec-123", "status": "pending", "chosen_option": None},
            {"id": "dec-123", "status": "resolved", "chosen_option": "option_b"},
        ]
        agent = _make_concrete_agent(tmp_path, supabase=sb)
        result = _run(agent.request_approval("Scale up?", "Yes", "No", "Load is high", poll_interval=0.01))
        assert result == "option_b"
        assert sb.poll_decision.call_count == 2


# ============================================================
# Execute lifecycle
# ============================================================


class TestExecuteLifecycle:
    def test_sets_running_then_completed(self, tmp_path: Path) -> None:
        from vincera.agents.base import AgentStatus

        state = _mock_state(tmp_path)
        agent = _make_concrete_agent(tmp_path, state=state)
        result = _run(agent.execute({"type": "scan"}))
        assert result == {"result": "done", "task": {"type": "scan"}}
        assert agent.status == AgentStatus.COMPLETED

        # Verify status transitions
        calls = state.update_agent_status.call_args_list
        assert len(calls) >= 2
        # First call: RUNNING
        assert calls[0][0][1] == "running"
        # Last call: COMPLETED
        assert calls[-1][0][1] == "completed"

    def test_sets_failed_on_exception(self, tmp_path: Path) -> None:
        from vincera.agents.base import AgentStatus
        from vincera.utils.errors import VinceraError

        agent = _make_failing_agent(tmp_path)
        with pytest.raises(VinceraError, match="Unexpected error"):
            _run(agent.execute({"type": "risky"}))
        assert agent.status == AgentStatus.FAILED

    def test_sends_error_message_on_failure(self, tmp_path: Path) -> None:
        from vincera.utils.errors import VinceraError

        sb = _mock_supabase()
        agent = _make_failing_agent(tmp_path)
        agent._sb = sb
        with pytest.raises(VinceraError):
            _run(agent.execute({"type": "fail"}))
        sb.send_message.assert_called()
        # The error alert should be sent with "alert" type
        last_call = sb.send_message.call_args_list[-1]
        assert last_call[0][3] == "alert"


# ============================================================
# Workspace and context
# ============================================================


class TestWorkspaceAndContext:
    def test_workspace_dir_created(self, tmp_path: Path) -> None:
        agent = _make_concrete_agent(tmp_path)
        assert agent.workspace_dir.exists()
        assert agent.workspace_dir.is_dir()
        assert agent.workspace_dir.name == "discovery"

    def test_get_context_returns_dict(self, tmp_path: Path) -> None:
        agent = _make_concrete_agent(tmp_path)
        ctx = _run(agent.get_context())
        assert isinstance(ctx, dict)
        assert "agent_status" in ctx
        assert "recent_actions" in ctx


# ============================================================
# Request verification
# ============================================================


class TestRequestVerification:
    def test_delegates_to_verifier(self, tmp_path: Path) -> None:
        verifier = _mock_verifier()
        agent = _make_concrete_agent(tmp_path, verifier=verifier)
        action = {"description": "Read file", "commands": ["cat /etc/hosts"]}
        result = _run(agent.request_verification(action))
        assert result.passed is True
        verifier.verify.assert_called_once()
