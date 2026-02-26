"""Unstuck Agent — handles failures, errors, and blocked states."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from pydantic import BaseModel

from vincera.agents.base import BaseAgent

if TYPE_CHECKING:
    from vincera.config import VinceraSettings
    from vincera.core.llm import OpenRouterClient
    from vincera.core.state import GlobalState
    from vincera.execution.sandbox import DockerSandbox
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.verification.verifier import Verifier

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class DiagnosisResult(BaseModel):
    problem_type: str  # code_error, timeout, resource_limit, dependency_failure, permission_denied, data_issue, unknown
    description: str
    root_cause: str
    suggested_fix: str
    confidence: float
    auto_fixable: bool


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

class UnstuckAgent(BaseAgent):
    """Diagnoses and fixes issues. The 'fixer' agent for error recovery."""

    def __init__(
        self,
        name: str,
        company_id: str,
        config: VinceraSettings,
        llm: OpenRouterClient,
        supabase: SupabaseManager,
        state: GlobalState,
        verifier: Verifier,
        sandbox: DockerSandbox,
    ) -> None:
        super().__init__(name, company_id, config, llm, supabase, state, verifier)
        self._sandbox = sandbox

    # ------------------------------------------------------------------
    # Main dispatch
    # ------------------------------------------------------------------

    async def run(self, task: dict) -> dict:
        task_type = task.get("type", "")

        if task_type == "diagnose":
            return await self._diagnose(task)
        elif task_type == "fix_script":
            return await self._fix_script(task)
        elif task_type == "investigate_failure":
            return await self._investigate(task)
        else:
            return {"status": "error", "reason": f"Unknown task type: {task_type}"}

    # ------------------------------------------------------------------
    # Diagnose
    # ------------------------------------------------------------------

    async def _diagnose(self, task: dict) -> dict:
        error = task.get("error", "")
        context = task.get("context", "")
        script = task.get("script", "")

        user_message = f"Diagnose this automation error:\n\nError: {error}\nContext: {context}\n"
        if script:
            user_message += f"\nScript (first 1000 chars):\n```python\n{script[:1000]}\n```\n"
        user_message += (
            "\nClassify the problem type as one of: code_error, timeout, resource_limit, "
            "dependency_failure, permission_denied, data_issue, unknown.\n"
            "Provide: description, root_cause, suggested_fix, confidence (0-1), and whether it's auto_fixable."
        )

        result = await self._llm.think_structured(
            "You are an automation error diagnostician.",
            user_message,
            {
                "type": "object",
                "properties": {
                    "problem_type": {"type": "string"},
                    "description": {"type": "string"},
                    "root_cause": {"type": "string"},
                    "suggested_fix": {"type": "string"},
                    "confidence": {"type": "number"},
                    "auto_fixable": {"type": "boolean"},
                },
            },
        )

        diagnosis = DiagnosisResult(
            problem_type=result.get("problem_type", "unknown") if isinstance(result, dict) else "unknown",
            description=result.get("description", "") if isinstance(result, dict) else "",
            root_cause=result.get("root_cause", "") if isinstance(result, dict) else "",
            suggested_fix=result.get("suggested_fix", "") if isinstance(result, dict) else "",
            confidence=result.get("confidence", 0.0) if isinstance(result, dict) else 0.0,
            auto_fixable=result.get("auto_fixable", False) if isinstance(result, dict) else False,
        )

        await self.send_message(
            f"Diagnosis: {diagnosis.problem_type}\n"
            f"Root cause: {diagnosis.root_cause}\n"
            f"Suggested fix: {diagnosis.suggested_fix}\n"
            f"Auto-fixable: {'Yes' if diagnosis.auto_fixable else 'No'} "
            f"(confidence: {diagnosis.confidence:.0%})",
            message_type="chat",
        )

        return {"status": "diagnosed", "diagnosis": diagnosis.model_dump()}

    # ------------------------------------------------------------------
    # Fix script
    # ------------------------------------------------------------------

    async def _fix_script(self, task: dict) -> dict:
        script = task.get("script", "")
        error = task.get("error", "")
        name = task.get("automation_name", "unknown")

        await self.send_message(f"Attempting to fix '{name}'...", message_type="chat")

        result = await self._llm.think_structured(
            "You are an expert Python script fixer.",
            f"Fix this Python script that's failing:\n\n"
            f"Script:\n```python\n{script[:3000]}\n```\n\n"
            f"Error: {error}\n\n"
            f"Return the fixed script.",
            {
                "type": "object",
                "properties": {
                    "fixed_script": {"type": "string"},
                    "changes_made": {"type": "array", "items": {"type": "string"}},
                    "confidence": {"type": "number"},
                },
            },
        )

        fixed_script = result.get("fixed_script", "") if isinstance(result, dict) else ""
        changes = result.get("changes_made", []) if isinstance(result, dict) else []
        confidence = result.get("confidence", 0.0) if isinstance(result, dict) else 0.0

        if not fixed_script:
            await self.send_message(f"Could not generate a fix for '{name}'.", message_type="chat")
            return {"status": "failed", "reason": "No fix generated"}

        test_result = await self._sandbox.execute_python(fixed_script, timeout=30)

        if test_result.success:
            await self.send_message(
                f"Fixed '{name}'! Changes: {', '.join(changes[:3])}. Sandbox test passed.",
                message_type="chat",
            )
            return {
                "status": "fixed",
                "fixed_script": fixed_script,
                "changes": changes,
                "confidence": confidence,
                "sandbox_passed": True,
            }
        else:
            await self.send_message(
                f"Generated a fix for '{name}' but sandbox test failed: {test_result.stderr[:200]}",
                message_type="chat",
            )
            return {
                "status": "partial",
                "fixed_script": fixed_script,
                "changes": changes,
                "confidence": confidence,
                "sandbox_passed": False,
                "sandbox_error": test_result.stderr[:500],
            }

    # ------------------------------------------------------------------
    # Investigate failure
    # ------------------------------------------------------------------

    async def _investigate(self, task: dict) -> dict:
        deployment_id = task.get("deployment_id", "")
        error_log = task.get("error_log", "")

        diagnosis = await self._diagnose({
            "type": "diagnose",
            "error": error_log,
            "context": f"Deployment {deployment_id} failure investigation",
        })

        await self.record_to_playbook(
            "error_investigation",
            f"Investigate deployment {deployment_id}",
            "LLM diagnosis",
            str(diagnosis.get("diagnosis", {})),
            True,
            f"Error: {error_log[:200]}",
        )

        return {
            "status": "investigated",
            "deployment_id": deployment_id,
            "diagnosis": diagnosis.get("diagnosis", {}),
        }
