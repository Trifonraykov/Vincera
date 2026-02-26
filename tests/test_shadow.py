"""Tests for vincera.execution.shadow — ShadowExecutor."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

from vincera.execution.sandbox import SandboxResult
from vincera.execution.shadow import ShadowExecutor, ShadowResult
from vincera.verification.verifier import CheckResult, VerificationResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _mock_sandbox(safe: bool = True, success: bool = True):
    sb = MagicMock()
    sb.validate_script_safety = AsyncMock(return_value=(safe, [] if safe else ["violation"]))
    sb.execute_python = AsyncMock(return_value=SandboxResult(
        success=success,
        exit_code=0 if success else 1,
        stdout="output data" if success else "",
        stderr="" if success else "script error",
        execution_time_seconds=0.5,
        sandbox_type="subprocess",
    ))
    return sb


def _mock_llm(confidence: float = 0.9):
    llm = MagicMock()
    llm.think_structured = AsyncMock(return_value={
        "produced": {"result": "invoice generated"},
        "side_effects": [],
        "data_accessed": ["invoices_table"],
        "data_would_modify": ["invoices_table"],
        "confidence": confidence,
    })
    return llm


def _mock_verifier(confidence: float = 0.9):
    verifier = MagicMock()
    verifier.verify = AsyncMock(return_value=VerificationResult(
        passed=True,
        checks=[CheckResult(name="test", passed=True, reason="ok")],
        confidence=confidence,
    ))
    return verifier


def _make_executor(safe=True, success=True, llm_conf=0.9, ver_conf=0.9):
    return ShadowExecutor(
        sandbox=_mock_sandbox(safe, success),
        llm=_mock_llm(llm_conf),
        verifier=_mock_verifier(ver_conf),
    )


# ===========================================================================
# Shadow execution tests
# ===========================================================================

class TestShadowRun:
    def test_unsafe_script(self) -> None:
        exe = _make_executor(safe=False)
        result = _run(exe.run_shadow("auto_invoice", "os.system('rm')", "generate invoice"))
        assert result.success is False
        assert result.recommendation == "fix"
        assert result.confidence_score == 0.0

    def test_sandbox_failure(self) -> None:
        exe = _make_executor(safe=True, success=False)
        result = _run(exe.run_shadow("auto_invoice", "print(x)", "generate invoice"))
        assert result.success is False
        assert result.recommendation == "fix"

    def test_success_high_confidence(self) -> None:
        exe = _make_executor(safe=True, success=True, llm_conf=0.9, ver_conf=0.9)
        result = _run(exe.run_shadow("auto_invoice", "print('ok')", "generate invoice"))
        assert result.success is True
        assert result.recommendation == "promote"
        assert result.confidence_score >= 0.8

    def test_medium_confidence(self) -> None:
        exe = _make_executor(safe=True, success=True, llm_conf=0.6, ver_conf=0.6)
        result = _run(exe.run_shadow("auto_invoice", "print('ok')", "generate invoice"))
        assert result.recommendation == "retry"

    def test_low_confidence(self) -> None:
        exe = _make_executor(safe=True, success=True, llm_conf=0.1, ver_conf=0.1)
        result = _run(exe.run_shadow("auto_invoice", "print('ok')", "generate invoice"))
        assert result.recommendation == "reject"

    def test_confidence_is_min(self) -> None:
        exe = _make_executor(safe=True, success=True, llm_conf=0.9, ver_conf=0.5)
        result = _run(exe.run_shadow("auto_invoice", "print('ok')", "generate invoice"))
        assert result.confidence_score == 0.5

    def test_result_fields(self) -> None:
        exe = _make_executor()
        result = _run(exe.run_shadow("auto_invoice", "print('ok')", "generate invoice"))
        assert isinstance(result, ShadowResult)
        assert result.automation_name == "auto_invoice"
        assert len(result.shadow_run_id) > 0
        assert isinstance(result.execution_time_seconds, float)
        assert isinstance(result.data_accessed, list)
        assert isinstance(result.data_would_modify, list)

    def test_evaluate_calls_llm(self) -> None:
        llm = _mock_llm()
        exe = ShadowExecutor(
            sandbox=_mock_sandbox(),
            llm=llm,
            verifier=_mock_verifier(),
        )
        _run(exe.run_shadow("auto_invoice", "print('ok')", "generate invoice"))
        llm.think_structured.assert_called_once()
        call_args = llm.think_structured.call_args
        # Should contain the automation name somewhere in the prompts
        assert "auto_invoice" in call_args[0][0] or "auto_invoice" in call_args[0][1]
