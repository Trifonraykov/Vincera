"""Test Generator — generates test cases for automation scripts."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.builder.code_generator import GeneratedCode
    from vincera.core.llm import OpenRouterClient

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class TestCase(BaseModel):
    """A single test case for an automation."""

    name: str
    description: str
    input_data: dict = {}
    expected_behavior: str
    validation_script: str = "pass"


# ---------------------------------------------------------------------------
# Generator
# ---------------------------------------------------------------------------

class TestGenerator:
    """Generates test cases for automation scripts using the LLM."""

    def __init__(self, llm: OpenRouterClient) -> None:
        self._llm = llm

    async def generate_tests(
        self,
        code: GeneratedCode,
        task_description: str,
        count: int = 3,
    ) -> list[TestCase]:
        result = await self._llm.think_structured(
            "You are a test engineer for Python automation scripts.",
            f"Generate {count} test cases for this automation.\n\n"
            f"Task: {task_description}\n"
            f"Script description: {code.description}\n"
            f"Inputs required: {code.inputs_required}\n"
            f"Outputs produced: {code.outputs_produced}\n\n"
            "For each test case provide: name, description, input_data (JSON), "
            "expected_behavior, and validation_script (Python assert statements).",
            {
                "type": "object",
                "properties": {
                    "test_cases": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "description": {"type": "string"},
                                "input_data": {"type": "object"},
                                "expected_behavior": {"type": "string"},
                                "validation_script": {"type": "string"},
                            },
                            "required": ["name", "description", "expected_behavior"],
                        },
                    },
                },
            },
        )

        cases = result.get("test_cases", []) if isinstance(result, dict) else []
        return [
            TestCase(
                name=tc.get("name", f"test_{i}"),
                description=tc.get("description", ""),
                input_data=tc.get("input_data", {}),
                expected_behavior=tc.get("expected_behavior", ""),
                validation_script=tc.get("validation_script", "pass"),
            )
            for i, tc in enumerate(cases)
        ]
