"""Tests for Stage 14 — CodeGenerator, CodeReviewer, TestGenerator, BuilderAgent."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from vincera.builder.code_generator import CodeGenerator, GeneratedCode
from vincera.builder.code_reviewer import CodeReviewer, ReviewResult
from vincera.builder.test_generator import TestCase, TestGenerator
from vincera.execution.sandbox import SandboxResult
from vincera.execution.shadow import ShadowResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _mock_settings(tmp_path: Path):
    settings = MagicMock()
    settings.home_dir = tmp_path / "VinceraHQ"
    settings.home_dir.mkdir(parents=True, exist_ok=True)
    for subdir in ("agents", "scripts"):
        (settings.home_dir / subdir).mkdir(parents=True, exist_ok=True)
    return settings


def _mock_supabase():
    sb = MagicMock()
    sb.send_message.return_value = {"id": "msg-1"}
    sb.log_event.return_value = None
    sb.add_playbook_entry.return_value = {"id": "pb-1"}
    sb.query_playbook.return_value = []
    sb.query_knowledge.return_value = []
    return sb


def _mock_llm(structured_return: dict | None = None):
    llm = MagicMock()
    llm.think = AsyncMock(return_value="response")
    default = {
        "script": "import json\nprint(json.dumps({'result': 'ok'}))",
        "description": "Generates output",
        "dependencies": [],
        "estimated_runtime_seconds": 5,
        "inputs_required": ["data"],
        "outputs_produced": ["result"],
        "safety_notes": [],
    }
    llm.think_structured = AsyncMock(return_value=structured_return or default)
    return llm


def _mock_sandbox(success: bool = True, safe: bool = True):
    sb = MagicMock()
    sb.execute_python = AsyncMock(return_value=SandboxResult(
        success=success,
        exit_code=0 if success else 1,
        stdout='{"result": "ok"}' if success else "",
        stderr="" if success else "SyntaxError: invalid syntax",
        execution_time_seconds=0.5,
        sandbox_type="subprocess",
    ))
    sb.validate_script_safety = AsyncMock(return_value=(safe, [] if safe else ["Found 'os.system'"]))
    return sb


def _mock_pipeline():
    pipe = MagicMock()
    pipe.start_deployment = AsyncMock(return_value=MagicMock(deployment_id="dep-1"))
    pipe.run_sandbox_stage = AsyncMock(return_value=SandboxResult(
        success=True, exit_code=0, stdout="ok", stderr="",
        execution_time_seconds=0.3, sandbox_type="subprocess",
    ))
    pipe.run_shadow_stage = AsyncMock(return_value=ShadowResult(
        automation_name="test_auto",
        shadow_run_id="sh-1",
        success=True,
        would_have_produced={"result": "done"},
        side_effects_detected=[],
        execution_time_seconds=0.5,
        data_accessed=[],
        data_would_modify=[],
        confidence_score=0.9,
        recommendation="promote",
    ))
    return pipe


def _sample_code(script: str = "print('ok')") -> GeneratedCode:
    return GeneratedCode(
        script=script,
        description="Test automation",
        dependencies=[],
        estimated_runtime_seconds=5,
        inputs_required=[],
        outputs_produced=["result"],
        safety_notes=[],
    )


# ===========================================================================
# CodeGenerator
# ===========================================================================

class TestCodeGeneratorGenerate:
    def test_returns_generated_code(self) -> None:
        gen = CodeGenerator(_mock_llm())
        code = _run(gen.generate("invoice_gen", "Generate invoices", "Ecommerce"))
        assert isinstance(code, GeneratedCode)
        assert len(code.script) > 0

    def test_task_in_prompt(self) -> None:
        llm = _mock_llm()
        gen = CodeGenerator(llm)
        _run(gen.generate("invoice_gen", "Generate invoices", "Ecommerce"))
        call_args = llm.think_structured.call_args
        user_msg = call_args[0][1]
        assert "invoice_gen" in user_msg

    def test_constraints_in_prompt(self) -> None:
        llm = _mock_llm()
        gen = CodeGenerator(llm)
        _run(gen.generate("task", "desc", "ctx", constraints=["No network", "JSON output"]))
        call_args = llm.think_structured.call_args
        user_msg = call_args[0][1]
        assert "No network" in user_msg
        assert "JSON output" in user_msg


class TestCodeGeneratorIterate:
    def test_error_in_prompt(self) -> None:
        llm = _mock_llm()
        gen = CodeGenerator(llm)
        original = _sample_code()
        _run(gen.iterate(original, "NameError: x is not defined"))
        call_args = llm.think_structured.call_args
        user_msg = call_args[0][1]
        assert "NameError" in user_msg

    def test_preserves_defaults(self) -> None:
        llm = _mock_llm({"script": "fixed()", "description": "fixed desc"})
        gen = CodeGenerator(llm)
        original = _sample_code()
        original.dependencies = ["pandas"]
        result = _run(gen.iterate(original, "error"))
        assert result.dependencies == ["pandas"]


# ===========================================================================
# CodeReviewer
# ===========================================================================

class TestCodeReviewer:
    def test_clean_code_approved(self) -> None:
        llm = _mock_llm({"issues": [], "suggestions": []})
        reviewer = CodeReviewer(llm, _mock_sandbox())
        code = _sample_code("import json\nprint(json.dumps({'ok': True}))")
        result = _run(reviewer.review(code, "Generate output"))
        assert isinstance(result, ReviewResult)
        assert result.approved is True
        assert result.quality_score == 1.0

    def test_catches_empty_script(self) -> None:
        llm = _mock_llm({"issues": [], "suggestions": []})
        reviewer = CodeReviewer(llm, _mock_sandbox())
        code = _sample_code("")
        result = _run(reviewer.review(code, "test"))
        assert result.approved is False
        assert any("empty" in i.lower() for i in result.issues)

    def test_catches_infinite_loop(self) -> None:
        llm = _mock_llm({"issues": [], "suggestions": []})
        reviewer = CodeReviewer(llm, _mock_sandbox())
        code = _sample_code("while True:\n  pass")
        result = _run(reviewer.review(code, "test"))
        assert result.approved is False
        assert any("loop" in i.lower() for i in result.issues)

    def test_catches_input(self) -> None:
        llm = _mock_llm({"issues": [], "suggestions": []})
        reviewer = CodeReviewer(llm, _mock_sandbox())
        code = _sample_code("x = input('Enter: ')")
        result = _run(reviewer.review(code, "test"))
        assert result.approved is False
        assert any("input" in i.lower() for i in result.issues)

    def test_catches_security(self) -> None:
        llm = _mock_llm({"issues": [], "suggestions": []})
        sandbox = _mock_sandbox(safe=False)
        reviewer = CodeReviewer(llm, sandbox)
        code = _sample_code("import os\nos.system('rm -rf /')")
        result = _run(reviewer.review(code, "test"))
        assert result.approved is False
        assert len(result.security_concerns) > 0

    def test_quality_score_decreases(self) -> None:
        llm = _mock_llm({"issues": ["bad logic", "missing check", "wrong format"], "suggestions": []})
        reviewer = CodeReviewer(llm, _mock_sandbox())
        code = _sample_code("print(1)")
        result = _run(reviewer.review(code, "test"))
        assert result.quality_score < 1.0


# ===========================================================================
# TestGenerator
# ===========================================================================

class TestTestGenerator:
    def test_returns_list(self) -> None:
        llm = _mock_llm({
            "test_cases": [
                {"name": "test_basic", "description": "Basic test", "expected_behavior": "Returns ok", "validation_script": "assert True"},
            ],
        })
        gen = TestGenerator(llm)
        code = _sample_code()
        tests = _run(gen.generate_tests(code, "test task"))
        assert isinstance(tests, list)
        assert len(tests) == 1
        assert isinstance(tests[0], TestCase)

    def test_count(self) -> None:
        llm = _mock_llm({
            "test_cases": [
                {"name": f"test_{i}", "description": f"Test {i}", "expected_behavior": "ok"}
                for i in range(3)
            ],
        })
        gen = TestGenerator(llm)
        tests = _run(gen.generate_tests(_sample_code(), "task", count=3))
        assert len(tests) == 3

    def test_handles_empty(self) -> None:
        llm = _mock_llm({"test_cases": []})
        gen = TestGenerator(llm)
        tests = _run(gen.generate_tests(_sample_code(), "task"))
        assert tests == []


# ===========================================================================
# BuilderAgent
# ===========================================================================

def _build_agent(tmp_path: Path, **overrides):
    from vincera.agents.builder import BuilderAgent

    llm = overrides.pop("llm", _mock_llm())
    sandbox = overrides.pop("sandbox", _mock_sandbox())
    pipeline = overrides.pop("pipeline", _mock_pipeline())
    generator = overrides.pop("generator", CodeGenerator(llm))
    reviewer_llm = _mock_llm({"issues": [], "suggestions": []})
    reviewer = overrides.pop("reviewer", CodeReviewer(reviewer_llm, sandbox))
    test_gen_llm = _mock_llm({"test_cases": [
        {"name": "test_basic", "description": "Basic", "expected_behavior": "ok"},
    ]})
    test_gen = overrides.pop("test_gen", TestGenerator(test_gen_llm))

    agent = BuilderAgent(
        name="builder",
        company_id="comp-1",
        config=_mock_settings(tmp_path),
        llm=llm,
        supabase=_mock_supabase(),
        state=MagicMock(),
        verifier=MagicMock(),
        code_generator=generator,
        code_reviewer=reviewer,
        test_generator=test_gen,
        sandbox=sandbox,
        pipeline=pipeline,
    )
    return agent, {
        "llm": llm, "sandbox": sandbox, "pipeline": pipeline,
        "generator": generator, "reviewer": reviewer, "test_gen": test_gen,
    }


_TASK = {
    "name": "auto_invoice",
    "description": "Generate invoices from order data",
    "business_context": "Ecommerce store",
    "domain": "finance",
}


class TestBuilderAgent:
    def test_run_success(self, tmp_path: Path) -> None:
        agent, mocks = _build_agent(tmp_path)
        result = _run(agent.run(_TASK))
        assert result["status"] == "success"
        assert result["deployment_id"] == "dep-1"
        assert result["shadow_confidence"] == 0.9

    def test_sandbox_failure_retries(self, tmp_path: Path) -> None:
        sandbox = _mock_sandbox()
        call_count = {"n": 0}

        async def _fail_then_pass(*args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] <= 2:
                return SandboxResult(
                    success=False, exit_code=1, stdout="", stderr="NameError",
                    execution_time_seconds=0.1, sandbox_type="subprocess",
                )
            return SandboxResult(
                success=True, exit_code=0, stdout="ok", stderr="",
                execution_time_seconds=0.3, sandbox_type="subprocess",
            )

        sandbox.execute_python = AsyncMock(side_effect=_fail_then_pass)
        agent, _ = _build_agent(tmp_path, sandbox=sandbox)
        result = _run(agent.run(_TASK))
        assert result["status"] == "success"

    def test_all_retries_fail(self, tmp_path: Path) -> None:
        sandbox = _mock_sandbox(success=False)
        agent, _ = _build_agent(tmp_path, sandbox=sandbox)
        result = _run(agent.run(_TASK))
        assert result["status"] == "failed"
        assert result["attempts"] == 3

    def test_sends_messages(self, tmp_path: Path) -> None:
        agent, _ = _build_agent(tmp_path)
        _run(agent.run(_TASK))
        assert agent._sb.send_message.call_count >= 3

    def test_records_playbook(self, tmp_path: Path) -> None:
        agent, _ = _build_agent(tmp_path)
        _run(agent.run(_TASK))
        agent._sb.add_playbook_entry.assert_called()

    def test_saves_script(self, tmp_path: Path) -> None:
        agent, _ = _build_agent(tmp_path)
        _run(agent.run(_TASK))
        scripts_dir = tmp_path / "VinceraHQ" / "scripts"
        saved = list(scripts_dir.glob("*.py"))
        assert len(saved) == 1

    def test_review_fails_triggers_fix(self, tmp_path: Path) -> None:
        llm = _mock_llm()
        # Reviewer LLM that finds issues first time
        review_call = {"n": 0}
        async def _review_structured(*args, **kwargs):
            review_call["n"] += 1
            if review_call["n"] == 1:
                return {"issues": ["Missing error handling"], "suggestions": []}
            return {"issues": [], "suggestions": []}
        reviewer_llm = MagicMock()
        reviewer_llm.think_structured = AsyncMock(side_effect=_review_structured)
        sandbox = _mock_sandbox()
        reviewer = CodeReviewer(reviewer_llm, sandbox)

        agent, _ = _build_agent(tmp_path, llm=llm, reviewer=reviewer, sandbox=sandbox)
        result = _run(agent.run(_TASK))
        # Generator.iterate should have been called to fix the review issues
        assert llm.think_structured.call_count >= 2  # generate + iterate (at minimum)


class TestBuilderHandleMessage:
    def test_build_keyword(self, tmp_path: Path) -> None:
        agent, _ = _build_agent(tmp_path)
        response = _run(agent.handle_message("build an invoice system"))
        assert isinstance(response, str)
        assert len(response) > 0
