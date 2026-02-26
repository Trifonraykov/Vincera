"""Tests for vincera.core.authority — AuthorityManager."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

from vincera.core.authority import (
    ActionRiskLevel,
    AuthorityLevel,
    AuthorityManager,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    """Run an async coroutine synchronously."""
    return asyncio.run(coro)


def _mock_supabase(authority_level: str = "ask_risky"):
    """Create a mock SupabaseManager returning the given authority level."""
    sb = MagicMock()
    sb.get_company.return_value = {"authority_level": authority_level}
    sb.update_company.return_value = {"id": "comp-1"}
    sb.send_message.return_value = {"id": "msg-1"}
    sb.log_event.return_value = {"id": "ev-1"}
    return sb


def _manager(authority_level: str = "ask_risky") -> AuthorityManager:
    """Create an AuthorityManager with a mocked Supabase."""
    sb = _mock_supabase(authority_level)
    return AuthorityManager(supabase=sb, company_id="comp-1")


def _mock_agent():
    """Create a mock BaseAgent with request_approval."""
    agent = MagicMock()
    agent.request_approval = AsyncMock(return_value="option_a")
    agent._name = "test-agent"
    return agent


# ===========================================================================
# classify_risk tests
# ===========================================================================

class TestClassifyRisk:
    def test_safe(self) -> None:
        mgr = _manager()
        level = mgr.classify_risk("Read dashboard data")
        assert level == ActionRiskLevel.SAFE

    def test_low(self) -> None:
        mgr = _manager()
        level = mgr.classify_risk("Batch internal notifications", is_bulk=True)
        assert level == ActionRiskLevel.LOW

    def test_medium(self) -> None:
        mgr = _manager()
        level = mgr.classify_risk("Delete temp file", is_reversible=False)
        assert level == ActionRiskLevel.MEDIUM

    def test_high_financial(self) -> None:
        mgr = _manager()
        level = mgr.classify_risk("Update invoice", affects_financial=True)
        assert level == ActionRiskLevel.HIGH

    def test_high_customer(self) -> None:
        mgr = _manager()
        level = mgr.classify_risk("Send email to client", affects_customer=True)
        assert level == ActionRiskLevel.HIGH

    def test_critical_bulk_financial(self) -> None:
        mgr = _manager()
        level = mgr.classify_risk(
            "Bulk update all invoices",
            is_bulk=True,
            affects_financial=True,
        )
        assert level == ActionRiskLevel.CRITICAL

    def test_critical_irreversible_system(self) -> None:
        mgr = _manager()
        level = mgr.classify_risk(
            "Drop database table",
            modifies_system=True,
            is_reversible=False,
        )
        assert level == ActionRiskLevel.CRITICAL


# ===========================================================================
# check_authority tests
# ===========================================================================

class TestCheckAuthority:
    def test_ask_risky_safe(self) -> None:
        mgr = _manager("ask_risky")
        decision = mgr.check_authority("read data", ActionRiskLevel.SAFE)
        assert decision.auto_approved is True
        assert decision.requires_approval is False

    def test_ask_risky_low(self) -> None:
        mgr = _manager("ask_risky")
        decision = mgr.check_authority("create file", ActionRiskLevel.LOW)
        assert decision.auto_approved is False
        assert decision.requires_approval is True

    def test_ask_high_only_medium(self) -> None:
        mgr = _manager("ask_high_only")
        decision = mgr.check_authority("modify data", ActionRiskLevel.MEDIUM)
        assert decision.auto_approved is True
        assert decision.requires_approval is False

    def test_ask_high_only_high(self) -> None:
        mgr = _manager("ask_high_only")
        decision = mgr.check_authority("update invoice", ActionRiskLevel.HIGH)
        assert decision.auto_approved is False
        assert decision.requires_approval is True

    def test_autonomous_high(self) -> None:
        mgr = _manager("autonomous")
        decision = mgr.check_authority("send email", ActionRiskLevel.HIGH)
        assert decision.auto_approved is True
        assert decision.requires_approval is False

    def test_autonomous_critical(self) -> None:
        mgr = _manager("autonomous")
        decision = mgr.check_authority("bulk delete", ActionRiskLevel.CRITICAL)
        assert decision.auto_approved is False
        assert decision.requires_approval is True

    def test_observer(self) -> None:
        mgr = _manager("observer")
        for level in ActionRiskLevel:
            decision = mgr.check_authority("anything", level)
            assert decision.requires_approval is True


# ===========================================================================
# can_act tests
# ===========================================================================

class TestCanAct:
    def test_observer(self) -> None:
        mgr = _manager("observer")
        assert mgr.can_act() is False

    def test_suggest(self) -> None:
        mgr = _manager("suggest")
        assert mgr.can_act() is False

    def test_ask_always(self) -> None:
        mgr = _manager("ask_always")
        assert mgr.can_act() is True


# ===========================================================================
# request_if_needed tests
# ===========================================================================

class TestRequestIfNeeded:
    def test_auto_approved(self) -> None:
        sb = _mock_supabase("autonomous")
        mgr = AuthorityManager(supabase=sb, company_id="comp-1")
        agent = _mock_agent()
        result = _run(mgr.request_if_needed(agent, "read data", ActionRiskLevel.SAFE))
        assert result is True
        agent.request_approval.assert_not_called()

    def test_requires_approval_approved(self) -> None:
        sb = _mock_supabase("ask_always")
        mgr = AuthorityManager(supabase=sb, company_id="comp-1")
        agent = _mock_agent()
        agent.request_approval = AsyncMock(return_value="option_a")
        result = _run(mgr.request_if_needed(agent, "create file", ActionRiskLevel.LOW))
        assert result is True
        agent.request_approval.assert_called_once()

    def test_requires_approval_denied(self) -> None:
        sb = _mock_supabase("ask_always")
        mgr = AuthorityManager(supabase=sb, company_id="comp-1")
        agent = _mock_agent()
        agent.request_approval = AsyncMock(return_value="option_b")
        result = _run(mgr.request_if_needed(agent, "delete file", ActionRiskLevel.LOW))
        assert result is False


# ===========================================================================
# get_restrictions_summary tests
# ===========================================================================

class TestRestrictionsSummary:
    def test_returns_nonempty_string(self) -> None:
        mgr = _manager()
        summary = mgr.get_restrictions_summary()
        assert isinstance(summary, str)
        assert len(summary) > 0
