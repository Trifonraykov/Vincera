"""Tests for vincera.execution.deployment_pipeline — DeploymentPipeline."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

from vincera.execution.deployment_pipeline import (
    DeploymentPipeline,
    DeploymentRecord,
    DeploymentStage,
)
from vincera.execution.sandbox import SandboxResult
from vincera.execution.shadow import ShadowResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _mock_sandbox():
    sb = MagicMock()
    sb.execute_python = AsyncMock(return_value=SandboxResult(
        success=True, exit_code=0, stdout="ok", stderr="",
        execution_time_seconds=0.3, sandbox_type="subprocess",
    ))
    return sb


def _mock_shadow(recommendation: str = "promote"):
    sh = MagicMock()
    sh.run_shadow = AsyncMock(return_value=ShadowResult(
        automation_name="auto_invoice",
        shadow_run_id="abc123",
        success=True,
        would_have_produced={"result": "done"},
        side_effects_detected=[],
        execution_time_seconds=0.5,
        data_accessed=["invoices"],
        data_would_modify=["invoices"],
        confidence_score=0.9,
        recommendation=recommendation,
    ))
    return sh


def _mock_supabase():
    sb = MagicMock()
    sb.upsert_automation.return_value = {"id": "auto-1"}
    sb.update_automation_status.return_value = {"id": "auto-1"}
    return sb


def _mock_authority(approved: bool = True):
    auth = MagicMock()
    auth.classify_risk.return_value = MagicMock(value="high")
    auth.request_if_needed = AsyncMock(return_value=approved)
    return auth


def _mock_agent():
    agent = MagicMock()
    agent.request_approval = AsyncMock(return_value="option_a")
    return agent


def _build_pipeline(**overrides):
    sandbox = overrides.pop("sandbox", _mock_sandbox())
    shadow = overrides.pop("shadow", _mock_shadow())
    supabase = overrides.pop("supabase", _mock_supabase())
    authority = overrides.pop("authority", _mock_authority())
    company_id = overrides.pop("company_id", "comp-1")

    pipe = DeploymentPipeline(
        sandbox=sandbox,
        shadow=shadow,
        supabase=supabase,
        authority=authority,
        company_id=company_id,
    )
    mocks = {
        "sandbox": sandbox, "shadow": shadow, "supabase": supabase,
        "authority": authority,
    }
    return pipe, mocks


# ===========================================================================
# start_deployment
# ===========================================================================

class TestStartDeployment:
    def test_creates_record(self) -> None:
        pipe, _ = _build_pipeline()
        record = _run(pipe.start_deployment("auto_invoice", "print('ok')", "generate invoices"))
        assert record.current_stage == DeploymentStage.SANDBOX
        assert record.automation_name == "auto_invoice"
        assert len(record.deployment_id) > 0

    def test_saves_to_supabase(self) -> None:
        pipe, mocks = _build_pipeline()
        _run(pipe.start_deployment("auto_invoice", "print('ok')", "generate invoices"))
        mocks["supabase"].upsert_automation.assert_called_once()


# ===========================================================================
# run stages
# ===========================================================================

class TestRunStages:
    def test_run_sandbox_stage(self) -> None:
        pipe, mocks = _build_pipeline()
        record = _run(pipe.start_deployment("auto_invoice", "print('ok')", "test"))
        result = _run(pipe.run_sandbox_stage(record.deployment_id))
        assert result.success is True
        updated = pipe.get_deployment(record.deployment_id)
        assert updated.sandbox_result is not None

    def test_run_shadow_stage(self) -> None:
        pipe, _ = _build_pipeline()
        record = _run(pipe.start_deployment("auto_invoice", "print('ok')", "test"))
        result = _run(pipe.run_shadow_stage(record.deployment_id, "generate invoices"))
        assert result.success is True
        updated = pipe.get_deployment(record.deployment_id)
        assert updated.shadow_result is not None


# ===========================================================================
# promote
# ===========================================================================

class TestPromote:
    def test_sandbox_to_shadow(self) -> None:
        pipe, _ = _build_pipeline()
        record = _run(pipe.start_deployment("auto_invoice", "print('ok')", "test"))
        _run(pipe.run_sandbox_stage(record.deployment_id))
        ok, stage = _run(pipe.promote(record.deployment_id))
        assert ok is True
        assert stage == "shadow"

    def test_sandbox_fails_if_not_passed(self) -> None:
        sandbox = _mock_sandbox()
        sandbox.execute_python = AsyncMock(return_value=SandboxResult(
            success=False, exit_code=1, stdout="", stderr="err",
            execution_time_seconds=0.1, sandbox_type="subprocess",
        ))
        pipe, _ = _build_pipeline(sandbox=sandbox)
        record = _run(pipe.start_deployment("auto_invoice", "bad", "test"))
        _run(pipe.run_sandbox_stage(record.deployment_id))
        ok, reason = _run(pipe.promote(record.deployment_id))
        assert ok is False
        assert "not pass" in reason.lower() or "did not" in reason.lower()

    def test_shadow_to_canary(self) -> None:
        pipe, _ = _build_pipeline()
        record = _run(pipe.start_deployment("auto_invoice", "print('ok')", "test"))
        # Walk through stages
        _run(pipe.run_sandbox_stage(record.deployment_id))
        _run(pipe.promote(record.deployment_id))  # → shadow
        _run(pipe.run_shadow_stage(record.deployment_id, "test"))
        ok, stage = _run(pipe.promote(record.deployment_id, agent=_mock_agent()))
        assert ok is True
        assert stage == "canary"

    def test_shadow_fails_bad_recommendation(self) -> None:
        shadow = _mock_shadow(recommendation="reject")
        pipe, _ = _build_pipeline(shadow=shadow)
        record = _run(pipe.start_deployment("auto_invoice", "print('ok')", "test"))
        _run(pipe.run_sandbox_stage(record.deployment_id))
        _run(pipe.promote(record.deployment_id))  # → shadow
        _run(pipe.run_shadow_stage(record.deployment_id, "test"))
        ok, reason = _run(pipe.promote(record.deployment_id))
        assert ok is False
        assert "reject" in reason.lower()

    def test_canary_checks_authority(self) -> None:
        pipe, mocks = _build_pipeline()
        record = _run(pipe.start_deployment("auto_invoice", "print('ok')", "test"))
        _run(pipe.run_sandbox_stage(record.deployment_id))
        _run(pipe.promote(record.deployment_id))  # → shadow
        _run(pipe.run_shadow_stage(record.deployment_id, "test"))
        agent = _mock_agent()
        _run(pipe.promote(record.deployment_id, agent=agent))  # → canary
        mocks["authority"].request_if_needed.assert_called()

    def test_promote_denied(self) -> None:
        auth = _mock_authority(approved=False)
        pipe, _ = _build_pipeline(authority=auth)
        record = _run(pipe.start_deployment("auto_invoice", "print('ok')", "test"))
        _run(pipe.run_sandbox_stage(record.deployment_id))
        _run(pipe.promote(record.deployment_id))  # → shadow
        _run(pipe.run_shadow_stage(record.deployment_id, "test"))
        ok, reason = _run(pipe.promote(record.deployment_id, agent=_mock_agent()))
        assert ok is False
        assert "denied" in reason.lower()

    def test_promote_from_full_fails(self) -> None:
        pipe, _ = _build_pipeline()
        record = _run(pipe.start_deployment("auto_invoice", "print('ok')", "test"))
        record.current_stage = DeploymentStage.FULL
        ok, reason = _run(pipe.promote(record.deployment_id))
        assert ok is False
        assert "cannot promote" in reason.lower()


# ===========================================================================
# rollback
# ===========================================================================

class TestRollback:
    def test_rollback(self) -> None:
        pipe, _ = _build_pipeline()
        record = _run(pipe.start_deployment("auto_invoice", "print('ok')", "test"))
        result = _run(pipe.rollback(record.deployment_id, "broken"))
        assert result is True
        updated = pipe.get_deployment(record.deployment_id)
        assert updated.current_stage == DeploymentStage.ROLLED_BACK

    def test_rollback_nonexistent(self) -> None:
        pipe, _ = _build_pipeline()
        result = _run(pipe.rollback("nonexistent-id", "reason"))
        assert result is False


# ===========================================================================
# queries
# ===========================================================================

class TestQueries:
    def test_get_deployment(self) -> None:
        pipe, _ = _build_pipeline()
        record = _run(pipe.start_deployment("auto_invoice", "print('ok')", "test"))
        fetched = pipe.get_deployment(record.deployment_id)
        assert fetched is not None
        assert fetched.automation_name == "auto_invoice"

    def test_get_active_deployments(self) -> None:
        pipe, _ = _build_pipeline()
        r1 = _run(pipe.start_deployment("auto1", "print(1)", "t"))
        r2 = _run(pipe.start_deployment("auto2", "print(2)", "t"))
        r3 = _run(pipe.start_deployment("auto3", "print(3)", "t"))
        # Mark one as FULL, one as ROLLED_BACK
        pipe._deployments[r2.deployment_id].current_stage = DeploymentStage.FULL
        pipe._deployments[r3.deployment_id].current_stage = DeploymentStage.ROLLED_BACK
        active = pipe.get_active_deployments()
        assert len(active) == 1
        assert active[0].automation_name == "auto1"
