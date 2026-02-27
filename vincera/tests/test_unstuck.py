"""Tests for vincera.agents.unstuck — UnstuckAgent."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from vincera.agents.unstuck import UnstuckAgent
from vincera.execution.sandbox import SandboxResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _mock_settings(tmp_path: Path):
    settings = MagicMock()
    settings.home_dir = tmp_path / "VinceraHQ"
    settings.home_dir.mkdir(parents=True, exist_ok=True)
    (settings.home_dir / "agents").mkdir(parents=True, exist_ok=True)
    return settings


def _mock_supabase():
    sb = MagicMock()
    sb.send_message.return_value = {"id": "msg-1"}
    sb.log_event.return_value = None
    sb.add_playbook_entry.return_value = {"id": "pb-1"}
    sb.query_playbook.return_value = []
    sb.query_knowledge.return_value = []
    return sb


def _mock_llm(diagnosis: dict | None = None, fix: dict | None = None):
    llm = MagicMock()
    default_diagnosis = {
        "problem_type": "code_error",
        "description": "Variable not defined",
        "root_cause": "Missing import",
        "suggested_fix": "Add import statement",
        "confidence": 0.85,
        "auto_fixable": True,
    }
    default_fix = {
        "fixed_script": "import os\nprint(os.getcwd())",
        "changes_made": ["Added import os"],
        "confidence": 0.9,
    }
    llm.think = AsyncMock(return_value="Diagnosis complete.")

    if fix is not None:
        # fix_script tests: return fix dict directly
        llm.think_structured = AsyncMock(return_value=fix)
    else:
        llm.think_structured = AsyncMock(return_value=diagnosis or default_diagnosis)

    return llm


def _mock_sandbox(success: bool = True):
    sb = MagicMock()
    sb.execute_python = AsyncMock(return_value=SandboxResult(
        success=success,
        exit_code=0 if success else 1,
        stdout="output ok" if success else "",
        stderr="" if success else "script error",
        execution_time_seconds=0.3,
        sandbox_type="subprocess",
    ))
    return sb


def _build_unstuck(tmp_path: Path, **overrides):
    llm = overrides.pop("llm", _mock_llm())
    sandbox = overrides.pop("sandbox", _mock_sandbox())

    agent = UnstuckAgent(
        name="unstuck",
        company_id="comp-1",
        config=_mock_settings(tmp_path),
        llm=llm,
        supabase=_mock_supabase(),
        state=MagicMock(),
        verifier=MagicMock(),
        sandbox=sandbox,
    )
    return agent, {"llm": llm, "sandbox": sandbox}


# ===========================================================================
# diagnose
# ===========================================================================

class TestDiagnose:
    def test_returns_result(self, tmp_path: Path) -> None:
        agent, _ = _build_unstuck(tmp_path)
        result = _run(agent.run({
            "type": "diagnose",
            "error": "NameError: name 'x' is not defined",
            "context": "Running auto_invoice",
        }))
        assert result["status"] == "diagnosed"
        assert result["diagnosis"]["problem_type"] == "code_error"

    def test_sends_message(self, tmp_path: Path) -> None:
        agent, _ = _build_unstuck(tmp_path)
        _run(agent.run({
            "type": "diagnose",
            "error": "NameError",
            "context": "test",
        }))
        assert agent._sb.send_message.call_count >= 1

    def test_with_script(self, tmp_path: Path) -> None:
        llm = _mock_llm()
        agent, mocks = _build_unstuck(tmp_path, llm=llm)
        _run(agent.run({
            "type": "diagnose",
            "error": "NameError",
            "context": "test",
            "script": "print(x)",
        }))
        # The LLM should have been called with the script in the prompt
        call_args = mocks["llm"].think_structured.call_args
        assert "print(x)" in call_args[0][1]  # user_message (2nd positional arg)


# ===========================================================================
# fix_script
# ===========================================================================

class TestFixScript:
    def test_success(self, tmp_path: Path) -> None:
        fix = {
            "fixed_script": "x = 1\nprint(x)",
            "changes_made": ["Defined variable x"],
            "confidence": 0.9,
        }
        llm = _mock_llm(fix=fix)
        agent, _ = _build_unstuck(tmp_path, llm=llm)
        result = _run(agent.run({
            "type": "fix_script",
            "script": "print(x)",
            "error": "NameError: name 'x' is not defined",
            "automation_name": "auto_invoice",
        }))
        assert result["status"] == "fixed"
        assert result["sandbox_passed"] is True

    def test_sandbox_fails(self, tmp_path: Path) -> None:
        fix = {
            "fixed_script": "x = 1\nprint(x)",
            "changes_made": ["Defined variable x"],
            "confidence": 0.9,
        }
        llm = _mock_llm(fix=fix)
        agent, _ = _build_unstuck(tmp_path, llm=llm, sandbox=_mock_sandbox(success=False))
        result = _run(agent.run({
            "type": "fix_script",
            "script": "print(x)",
            "error": "NameError",
            "automation_name": "auto_invoice",
        }))
        assert result["status"] == "partial"
        assert result["sandbox_passed"] is False

    def test_no_fix(self, tmp_path: Path) -> None:
        fix = {"fixed_script": "", "changes_made": [], "confidence": 0.0}
        llm = _mock_llm(fix=fix)
        agent, _ = _build_unstuck(tmp_path, llm=llm)
        result = _run(agent.run({
            "type": "fix_script",
            "script": "print(x)",
            "error": "NameError",
            "automation_name": "auto_invoice",
        }))
        assert result["status"] == "failed"

    def test_sends_messages(self, tmp_path: Path) -> None:
        fix = {
            "fixed_script": "x = 1\nprint(x)",
            "changes_made": ["Defined variable x"],
            "confidence": 0.9,
        }
        llm = _mock_llm(fix=fix)
        agent, _ = _build_unstuck(tmp_path, llm=llm)
        _run(agent.run({
            "type": "fix_script",
            "script": "print(x)",
            "error": "NameError",
            "automation_name": "auto_invoice",
        }))
        assert agent._sb.send_message.call_count >= 1


# ===========================================================================
# investigate_failure
# ===========================================================================

class TestInvestigate:
    def test_calls_diagnose(self, tmp_path: Path) -> None:
        agent, mocks = _build_unstuck(tmp_path)
        result = _run(agent.run({
            "type": "investigate_failure",
            "deployment_id": "dep-1",
            "error_log": "Timeout after 30s",
        }))
        assert result["status"] == "investigated"
        assert result["deployment_id"] == "dep-1"
        # LLM should have been called for diagnosis
        mocks["llm"].think_structured.assert_called()

    def test_records_playbook(self, tmp_path: Path) -> None:
        agent, _ = _build_unstuck(tmp_path)
        _run(agent.run({
            "type": "investigate_failure",
            "deployment_id": "dep-1",
            "error_log": "Timeout after 30s",
        }))
        agent._sb.add_playbook_entry.assert_called()


# ===========================================================================
# unknown task type
# ===========================================================================

class TestUnknownTask:
    def test_unknown(self, tmp_path: Path) -> None:
        agent, _ = _build_unstuck(tmp_path)
        result = _run(agent.run({"type": "invalid"}))
        assert result["status"] == "error"
