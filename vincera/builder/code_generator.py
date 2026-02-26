"""Code Generator — produces Python automation scripts via LLM."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.core.llm import OpenRouterClient

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class GeneratedCode(BaseModel):
    """Output of the code generation step."""

    script: str
    description: str
    dependencies: list[str] = []
    estimated_runtime_seconds: int = 30
    inputs_required: list[str] = []
    outputs_produced: list[str] = []
    safety_notes: list[str] = []


# ---------------------------------------------------------------------------
# Generator
# ---------------------------------------------------------------------------

_GENERATE_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "script": {"type": "string"},
        "description": {"type": "string"},
        "dependencies": {"type": "array", "items": {"type": "string"}},
        "estimated_runtime_seconds": {"type": "integer"},
        "inputs_required": {"type": "array", "items": {"type": "string"}},
        "outputs_produced": {"type": "array", "items": {"type": "string"}},
        "safety_notes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["script", "description"],
}


class CodeGenerator:
    """Generates Python automation scripts using the LLM."""

    def __init__(self, llm: OpenRouterClient) -> None:
        self._llm = llm

    async def generate(
        self,
        task_name: str,
        task_description: str,
        business_context: str,
        constraints: list[str] | None = None,
    ) -> GeneratedCode:
        constraint_text = ""
        if constraints:
            constraint_text = "\n".join(f"- {c}" for c in constraints)

        user_message = (
            f"Task: {task_name}\n"
            f"Description: {task_description}\n"
            f"Business context: {business_context}\n\n"
            "Constraints:\n"
            "- Script must be self-contained (single file)\n"
            "- Use only Python standard library unless absolutely necessary\n"
            "- Print results to stdout as JSON\n"
            "- Handle errors gracefully — never crash silently\n"
            "- Include logging via print() statements for traceability\n"
            "- No interactive input (no input() calls)\n"
            "- No network access unless the task explicitly requires it\n"
            "- No file system writes outside of stdout\n"
            f"{constraint_text}\n\n"
            "Respond with the complete Python script and metadata."
        )

        result = await self._llm.think_structured(
            "You are a Python automation engineer. Write a self-contained script.",
            user_message,
            _GENERATE_SCHEMA,
        )

        if not isinstance(result, dict):
            result = {}

        return GeneratedCode(
            script=result.get("script", ""),
            description=result.get("description", ""),
            dependencies=result.get("dependencies", []),
            estimated_runtime_seconds=result.get("estimated_runtime_seconds", 30),
            inputs_required=result.get("inputs_required", []),
            outputs_produced=result.get("outputs_produced", []),
            safety_notes=result.get("safety_notes", []),
        )

    async def iterate(
        self,
        original: GeneratedCode,
        error_message: str,
        feedback: str = "",
    ) -> GeneratedCode:
        user_message = (
            f"The following automation script had an issue. Fix it.\n\n"
            f"Original script:\n```python\n{original.script}\n```\n\n"
            f"Error/Issue: {error_message}\n"
            f"{f'Additional feedback: {feedback}' if feedback else ''}\n\n"
            "Requirements:\n"
            "- Fix the specific issue\n"
            "- Keep the same overall structure\n"
            "- Maintain all safety constraints from the original\n"
            "- Return the complete fixed script"
        )

        result = await self._llm.think_structured(
            "You are a Python automation engineer. Fix the broken script.",
            user_message,
            _GENERATE_SCHEMA,
        )

        if not isinstance(result, dict):
            result = {}

        return GeneratedCode(
            script=result.get("script", original.script),
            description=result.get("description", original.description),
            dependencies=result.get("dependencies", original.dependencies),
            estimated_runtime_seconds=result.get("estimated_runtime_seconds", original.estimated_runtime_seconds),
            inputs_required=result.get("inputs_required", original.inputs_required),
            outputs_produced=result.get("outputs_produced", original.outputs_produced),
            safety_notes=result.get("safety_notes", original.safety_notes),
        )
