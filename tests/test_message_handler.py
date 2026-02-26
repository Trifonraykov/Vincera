"""Tests for vincera.core.message_handler — MessageHandler."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from vincera.core.message_handler import MessageHandler


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _run(coro):
    return asyncio.run(coro)


def _mock_orchestrator() -> MagicMock:
    orch = MagicMock()
    orch.handle_user_message = AsyncMock()
    orch._authority = MagicMock()
    orch._authority.get_restrictions_summary.return_value = "Authority level: observe"
    return orch


def _mock_agents() -> dict[str, MagicMock]:
    agents = {}
    for name in ("discovery", "research", "builder", "operator", "analyst", "unstuck", "trainer"):
        a = MagicMock()
        a.handle_message = AsyncMock(return_value="ok")
        agents[name] = a
    return agents


def _mock_corrections() -> MagicMock:
    c = MagicMock()
    c.record_correction = AsyncMock()
    return c


def _mock_supabase() -> MagicMock:
    sb = MagicMock()
    sb.send_message.return_value = {"id": "msg-1"}
    sb.resolve_decision.return_value = {"id": "d-1"}
    return sb


def _build_handler(**overrides) -> MessageHandler:
    return MessageHandler(
        orchestrator=overrides.get("orchestrator", _mock_orchestrator()),
        agents=overrides.get("agents", _mock_agents()),
        corrections=overrides.get("corrections", _mock_corrections()),
        supabase=overrides.get("supabase", _mock_supabase()),
        company_id=overrides.get("company_id", "comp-1"),
    )


def _msg(content: str, **kw) -> dict:
    base = {
        "id": "m-1",
        "company_id": "comp-1",
        "sender": "user",
        "content": content,
        "message_type": "chat",
        "metadata": {},
        "created_at": "2026-01-01T00:00:00Z",
    }
    base.update(kw)
    return base


# ===========================================================================
# Routing: default to orchestrator
# ===========================================================================


class TestDefaultRouting:
    def test_handle_user_chat(self) -> None:
        orch = _mock_orchestrator()
        handler = _build_handler(orchestrator=orch)
        _run(handler.handle(_msg("hello")))
        orch.handle_user_message.assert_awaited_once_with("hello")

    def test_ignores_agent_messages(self) -> None:
        orch = _mock_orchestrator()
        agents = _mock_agents()
        handler = _build_handler(orchestrator=orch, agents=agents)
        _run(handler.handle(_msg("hello", sender="builder")))
        orch.handle_user_message.assert_not_awaited()
        for a in agents.values():
            a.handle_message.assert_not_awaited()


# ===========================================================================
# Routing: keyword matching
# ===========================================================================


class TestKeywordRouting:
    def test_route_to_builder(self) -> None:
        agents = _mock_agents()
        handler = _build_handler(agents=agents)
        _run(handler.handle(_msg("build an invoice system")))
        agents["builder"].handle_message.assert_awaited_once()

    def test_route_to_analyst(self) -> None:
        agents = _mock_agents()
        handler = _build_handler(agents=agents)
        _run(handler.handle(_msg("analyze performance")))
        agents["analyst"].handle_message.assert_awaited_once()

    def test_route_to_unstuck(self) -> None:
        agents = _mock_agents()
        handler = _build_handler(agents=agents)
        _run(handler.handle(_msg("fix the broken script")))
        agents["unstuck"].handle_message.assert_awaited_once()

    def test_route_to_research(self) -> None:
        agents = _mock_agents()
        handler = _build_handler(agents=agents)
        _run(handler.handle(_msg("research best practices")))
        agents["research"].handle_message.assert_awaited_once()


# ===========================================================================
# Routing: @mention and metadata
# ===========================================================================


class TestExplicitRouting:
    def test_route_by_at_mention(self) -> None:
        agents = _mock_agents()
        handler = _build_handler(agents=agents)
        _run(handler.handle(_msg("@builder make something")))
        agents["builder"].handle_message.assert_awaited_once()

    def test_route_by_metadata(self) -> None:
        agents = _mock_agents()
        handler = _build_handler(agents=agents)
        _run(handler.handle(_msg("do the thing", metadata={"target_agent": "operator"})))
        agents["operator"].handle_message.assert_awaited_once()


# ===========================================================================
# Corrections
# ===========================================================================


class TestCorrections:
    def test_handle_correction_by_content(self) -> None:
        corrections = _mock_corrections()
        handler = _build_handler(corrections=corrections)
        _run(handler.handle(_msg("that's wrong, do it like this instead")))
        corrections.record_correction.assert_awaited_once()

    def test_handle_correction_by_type(self) -> None:
        corrections = _mock_corrections()
        handler = _build_handler(corrections=corrections)
        _run(handler.handle(_msg("use bullet points", message_type="correction",
                                  metadata={"correcting_agent": "builder", "original_action": "wrote paragraphs"})))
        corrections.record_correction.assert_awaited_once()


# ===========================================================================
# Decision responses
# ===========================================================================


class TestDecisionResponse:
    def test_handle_decision_response(self) -> None:
        sb = _mock_supabase()
        handler = _build_handler(supabase=sb)
        _run(handler.handle(_msg(
            "",
            message_type="decision_response",
            metadata={"decision_id": "d-42", "resolution": "option_a"},
        )))
        sb.resolve_decision.assert_called_once_with("d-42", "option_a")


# ===========================================================================
# System commands
# ===========================================================================


class TestSystemCommands:
    def test_handle_status_command(self) -> None:
        orch = _mock_orchestrator()
        handler = _build_handler(orchestrator=orch)
        _run(handler.handle(_msg("status")))
        orch.handle_user_message.assert_awaited_once()

    def test_handle_pause_command(self) -> None:
        orch = _mock_orchestrator()
        handler = _build_handler(orchestrator=orch)
        _run(handler.handle(_msg("pause")))
        orch.handle_user_message.assert_awaited_once()

    def test_handle_help_command(self) -> None:
        sb = _mock_supabase()
        handler = _build_handler(supabase=sb)
        _run(handler.handle(_msg("help")))
        sb.send_message.assert_called()
        content = sb.send_message.call_args[0][2]
        assert "what I can do" in content.lower() or "help" in content.lower() or "commands" in content.lower()

    def test_handle_authority_command(self) -> None:
        sb = _mock_supabase()
        orch = _mock_orchestrator()
        handler = _build_handler(orchestrator=orch, supabase=sb)
        _run(handler.handle(_msg("authority")))
        sb.send_message.assert_called()
        content = sb.send_message.call_args[0][2]
        assert "authority" in content.lower()


# ===========================================================================
# Correction detection
# ===========================================================================


class TestIsCorrection:
    def test_detects_correction_phrases(self) -> None:
        handler = _build_handler()
        assert handler._is_correction("That's wrong, use CSV format") is True
        assert handler._is_correction("No, do it differently") is True
        assert handler._is_correction("Incorrect output format") is True
        assert handler._is_correction("That's not right") is True

    def test_negative(self) -> None:
        handler = _build_handler()
        assert handler._is_correction("Build me a report") is False
        assert handler._is_correction("What's the weather") is False
        assert handler._is_correction("How are things going") is False


# ===========================================================================
# Route returns None
# ===========================================================================


class TestRouteReturnsNone:
    def test_no_match_falls_to_orchestrator(self) -> None:
        orch = _mock_orchestrator()
        handler = _build_handler(orchestrator=orch)
        _run(handler.handle(_msg("what's the weather like today")))
        orch.handle_user_message.assert_awaited_once_with("what's the weather like today")
