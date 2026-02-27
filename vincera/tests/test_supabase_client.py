"""Tests for vincera.knowledge.supabase_client — all Supabase calls mocked."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest


# ============================================================
# Helpers
# ============================================================


def _mock_supabase_client() -> MagicMock:
    """Build a mock supabase.Client with chainable table().method().execute()."""
    client = MagicMock()

    def _make_table_mock():
        table = MagicMock()
        # Chain: table("x").insert({}).execute() -> response
        for method_name in (
            "insert", "upsert", "update", "delete", "select",
        ):
            chain = getattr(table, method_name).return_value
            # Allow .eq/.gte/.lte/.ilike/.contains/.order/.limit chains
            for filter_name in ("eq", "gte", "lte", "ilike", "contains", "order", "limit", "neq", "gt", "lt"):
                setattr(chain, filter_name, MagicMock(return_value=chain))
            chain.execute.return_value = MagicMock(data=[{"id": "test-id-123"}])
        return table

    client.table = MagicMock(side_effect=lambda name: _make_table_mock())
    return client


def _make_manager(**overrides):
    """Create a SupabaseManager with mocked Supabase client."""
    from vincera.knowledge.supabase_client import SupabaseManager

    with patch("vincera.knowledge.supabase_client.create_client") as mock_create:
        mock_client = _mock_supabase_client()
        mock_create.return_value = mock_client
        defaults = dict(
            supabase_url="https://test.supabase.co",
            supabase_key="test-key",
            company_id="comp-123",
        )
        defaults.update(overrides)
        manager = SupabaseManager(**defaults)
        manager._mock_client = mock_client  # expose for assertions
        return manager


# ============================================================
# Messages (the chat system)
# ============================================================


class TestMessages:
    def test_send_message(self) -> None:
        mgr = _make_manager()
        result = mgr.send_message(
            company_id="comp-123",
            agent_name="discovery",
            content="Hello from Discovery",
            message_type="chat",
        )
        assert result is not None

    def test_get_chat_history(self) -> None:
        mgr = _make_manager()
        result = mgr.get_chat_history("comp-123", "discovery", limit=10)
        assert isinstance(result, list)

    def test_get_new_messages(self) -> None:
        mgr = _make_manager()
        result = mgr.get_new_messages("comp-123", since_timestamp="2025-01-01T00:00:00Z")
        assert isinstance(result, list)


# ============================================================
# Decisions
# ============================================================


class TestDecisions:
    def test_create_decision(self) -> None:
        mgr = _make_manager()
        result = mgr.create_decision(
            company_id="comp-123",
            agent_name="builder",
            question="Deploy to production?",
            option_a="Yes, deploy now",
            option_b="Wait for more testing",
            context="All tests pass",
            risk_level="medium",
        )
        assert result is not None

    def test_resolve_decision(self) -> None:
        mgr = _make_manager()
        result = mgr.resolve_decision("dec-123", chosen_option="option_a", note="Approved")
        assert result is not None

    def test_poll_decision(self) -> None:
        mgr = _make_manager()
        result = mgr.poll_decision("dec-123")
        assert result is not None

    def test_get_pending_decisions(self) -> None:
        mgr = _make_manager()
        result = mgr.get_pending_decisions("comp-123")
        assert isinstance(result, list)


# ============================================================
# Events
# ============================================================


class TestEvents:
    def test_log_event(self) -> None:
        mgr = _make_manager()
        result = mgr.log_event(
            company_id="comp-123",
            event_type="deployment",
            agent_name="builder",
            message="Deployed v1.0",
            severity="info",
        )
        assert result is not None

    def test_get_events(self) -> None:
        mgr = _make_manager()
        result = mgr.get_events("comp-123", limit=20)
        assert isinstance(result, list)

    def test_get_events_with_filters(self) -> None:
        mgr = _make_manager()
        result = mgr.get_events("comp-123", agent_name="builder", severity="error")
        assert isinstance(result, list)


# ============================================================
# Connection failure handling
# ============================================================


class TestConnectionFailure:
    def test_send_message_on_failure(self) -> None:
        mgr = _make_manager()
        mgr._client.table = MagicMock(side_effect=Exception("connection lost"))
        result = mgr.send_message("comp-123", "agent", "hello")
        assert result is None

    def test_get_events_on_failure(self) -> None:
        mgr = _make_manager()
        mgr._client.table = MagicMock(side_effect=Exception("timeout"))
        result = mgr.get_events("comp-123")
        assert result == []

    def test_create_decision_on_failure(self) -> None:
        mgr = _make_manager()
        mgr._client.table = MagicMock(side_effect=Exception("network error"))
        result = mgr.create_decision(
            "comp-123", "agent", "q?", "a", "b", "ctx"
        )
        assert result is None

    def test_log_event_on_failure(self) -> None:
        mgr = _make_manager()
        mgr._client.table = MagicMock(side_effect=Exception("fail"))
        result = mgr.log_event("comp-123", "test", "agent", "msg")
        assert result is None


# ============================================================
# All 14 method groups exist
# ============================================================


class TestMethodGroupsExist:
    def test_companies(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.register_company)
        assert callable(mgr.update_company)
        assert callable(mgr.get_company)

    def test_agent_statuses(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.update_agent_status)
        assert callable(mgr.get_agent_statuses)

    def test_automations(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.upsert_automation)
        assert callable(mgr.update_automation_status)
        assert callable(mgr.get_automations)

    def test_events(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.log_event)
        assert callable(mgr.get_events)

    def test_messages(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.send_message)
        assert callable(mgr.get_new_messages)
        assert callable(mgr.get_chat_history)

    def test_knowledge(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.add_knowledge)
        assert callable(mgr.query_knowledge)

    def test_decisions(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.create_decision)
        assert callable(mgr.resolve_decision)
        assert callable(mgr.poll_decision)
        assert callable(mgr.get_pending_decisions)

    def test_playbooks(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.add_playbook_entry)
        assert callable(mgr.query_playbook)

    def test_corrections(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.log_correction)
        assert callable(mgr.get_unapplied_corrections)
        assert callable(mgr.mark_correction_applied)

    def test_research(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.add_research_source)
        assert callable(mgr.add_research_insight)
        assert callable(mgr.get_research_library)

    def test_brain_states(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.save_brain_state)
        assert callable(mgr.get_latest_brain_state)

    def test_ghost_reports(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.save_ghost_report)
        assert callable(mgr.get_ghost_reports)

    def test_metrics(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.increment_metric)
        assert callable(mgr.get_metrics)

    def test_cross_company(self) -> None:
        mgr = _make_manager()
        assert callable(mgr.add_pattern)
        assert callable(mgr.query_patterns)
