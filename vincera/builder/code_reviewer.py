"""Code Reviewer — static + LLM review for generated automation scripts."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.builder.code_generator import GeneratedCode
    from vincera.core.llm import OpenRouterClient
    from vincera.execution.sandbox import DockerSandbox

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class ReviewResult(BaseModel):
    """Result of a code review."""

    approved: bool
    issues: list[str] = []
    suggestions: list[str] = []
    security_concerns: list[str] = []
    quality_score: float = 0.0


# ---------------------------------------------------------------------------
# Reviewer
# ---------------------------------------------------------------------------

class CodeReviewer:
    """Reviews generated code for quality, safety, and correctness."""

    def __init__(self, llm: OpenRouterClient, sandbox: DockerSandbox) -> None:
        self._llm = llm
        self._sandbox = sandbox

    async def review(self, code: GeneratedCode, task_description: str) -> ReviewResult:
        issues: list[str] = []
        security_concerns: list[str] = []

        # Phase 1: Static safety check via sandbox validator
        safe, violations = await self._sandbox.validate_script_safety(code.script)
        if not safe:
            security_concerns.extend(violations)

        # Phase 2: Basic code quality checks
        if not code.script.strip():
            issues.append("Empty script")
        if len(code.script) > 50000:
            issues.append("Script exceeds 50K characters — too large")
        if "import os" in code.script and "os.system" in code.script:
            security_concerns.append("Uses os.system — direct system command execution")
        if "while True" in code.script and "break" not in code.script:
            issues.append("Potential infinite loop (while True without break)")
        if "input(" in code.script:
            issues.append("Contains input() — scripts must be non-interactive")

        # Phase 3: LLM review for logic and correctness
        llm_review = await self._llm_review(code, task_description)
        issues.extend(llm_review.get("issues", []))
        suggestions = llm_review.get("suggestions", [])

        # Quality score
        total_problems = len(issues) + len(security_concerns)
        quality_score = max(0.0, 1.0 - (total_problems * 0.2))

        approved = len(security_concerns) == 0 and len(issues) == 0

        return ReviewResult(
            approved=approved,
            issues=issues,
            suggestions=suggestions,
            security_concerns=security_concerns,
            quality_score=round(quality_score, 2),
        )

    async def _llm_review(self, code: GeneratedCode, task_description: str) -> dict:
        result = await self._llm.think_structured(
            "You are a code reviewer for Python automation scripts.",
            f"Review this script for correctness and quality.\n\n"
            f"Task: {task_description}\n"
            f"Script:\n```python\n{code.script[:3000]}\n```\n\n"
            "Check for: logic errors, edge cases, error handling, output format.\n"
            "Do NOT flag security issues (those are checked separately).",
            {
                "type": "object",
                "properties": {
                    "issues": {"type": "array", "items": {"type": "string"}},
                    "suggestions": {"type": "array", "items": {"type": "string"}},
                },
            },
        )
        return result if isinstance(result, dict) else {}
