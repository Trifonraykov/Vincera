"""Shadow Executor — dry runs with live context, capturing outputs."""

from __future__ import annotations

import logging
import uuid
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.core.llm import OpenRouterClient
    from vincera.execution.sandbox import DockerSandbox
    from vincera.verification.verifier import Verifier

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class ShadowResult(BaseModel):
    """Result of a shadow execution."""

    automation_name: str
    shadow_run_id: str
    success: bool
    would_have_produced: dict
    side_effects_detected: list[str]
    execution_time_seconds: float
    data_accessed: list[str]
    data_would_modify: list[str]
    confidence_score: float
    recommendation: str  # "promote", "retry", "fix", "reject"


# ---------------------------------------------------------------------------
# Executor
# ---------------------------------------------------------------------------

class ShadowExecutor:
    """Runs automations in shadow mode — real execution, captured outputs."""

    def __init__(
        self,
        sandbox: DockerSandbox,
        llm: OpenRouterClient,
        verifier: Verifier,
    ) -> None:
        self._sandbox = sandbox
        self._llm = llm
        self._verifier = verifier

    async def run_shadow(
        self,
        automation_name: str,
        script: str,
        expected_behavior: str,
        test_data: dict | None = None,
    ) -> ShadowResult:
        shadow_id = str(uuid.uuid4())[:8]

        # 1. Safety check
        safe, violations = await self._sandbox.validate_script_safety(script)
        if not safe:
            return ShadowResult(
                automation_name=automation_name,
                shadow_run_id=shadow_id,
                success=False,
                would_have_produced={},
                side_effects_detected=violations,
                execution_time_seconds=0.0,
                data_accessed=[],
                data_would_modify=[],
                confidence_score=0.0,
                recommendation="fix",
            )

        # 2. Run in sandbox
        sandbox_result = await self._sandbox.execute_python(script, timeout=30)

        if not sandbox_result.success:
            return ShadowResult(
                automation_name=automation_name,
                shadow_run_id=shadow_id,
                success=False,
                would_have_produced={
                    "stdout": sandbox_result.stdout,
                    "stderr": sandbox_result.stderr,
                },
                side_effects_detected=[
                    f"Script failed with exit code {sandbox_result.exit_code}",
                ],
                execution_time_seconds=sandbox_result.execution_time_seconds,
                data_accessed=[],
                data_would_modify=[],
                confidence_score=0.0,
                recommendation="fix",
            )

        # 3. Evaluate results with LLM
        evaluation = await self._evaluate_shadow_run(
            automation_name, script, expected_behavior,
            sandbox_result.stdout, sandbox_result.stderr,
        )

        # 4. Verify with verification layer
        verification = await self._verifier.verify(
            {
                "type": "shadow_execution",
                "automation": automation_name,
                "script": script[:500],
                "output": sandbox_result.stdout[:500],
                "expected": expected_behavior,
            },
            {},
        )

        confidence = min(
            evaluation.get("confidence", 0.5),
            verification.confidence,
        )

        if confidence >= 0.8 and sandbox_result.success:
            recommendation = "promote"
        elif confidence >= 0.5:
            recommendation = "retry"
        elif confidence >= 0.2:
            recommendation = "fix"
        else:
            recommendation = "reject"

        return ShadowResult(
            automation_name=automation_name,
            shadow_run_id=shadow_id,
            success=sandbox_result.success,
            would_have_produced=evaluation.get("produced", {}),
            side_effects_detected=evaluation.get("side_effects", []),
            execution_time_seconds=sandbox_result.execution_time_seconds,
            data_accessed=evaluation.get("data_accessed", []),
            data_would_modify=evaluation.get("data_would_modify", []),
            confidence_score=confidence,
            recommendation=recommendation,
        )

    async def _evaluate_shadow_run(
        self,
        name: str,
        script: str,
        expected: str,
        stdout: str,
        stderr: str,
    ) -> dict:
        """Use LLM to evaluate shadow run results."""
        system_prompt = "You are a shadow execution evaluator for automation scripts."
        user_message = (
            f"Evaluate this automation shadow run:\n"
            f"Automation: {name}\n"
            f"Expected behavior: {expected}\n"
            f"Script (first 500 chars): {script[:500]}\n"
            f"Stdout: {stdout[:500]}\n"
            f"Stderr: {stderr[:500]}\n\n"
            f"Analyze: What did this produce? Any side effects? "
            f"What data would it access/modify? Confidence 0-1 that it works correctly?"
        )
        schema = {
            "type": "object",
            "properties": {
                "produced": {"type": "object"},
                "side_effects": {"type": "array", "items": {"type": "string"}},
                "data_accessed": {"type": "array", "items": {"type": "string"}},
                "data_would_modify": {"type": "array", "items": {"type": "string"}},
                "confidence": {"type": "number"},
            },
        }
        response = await self._llm.think_structured(system_prompt, user_message, schema)
        return response if isinstance(response, dict) else {}
