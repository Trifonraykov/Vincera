"""Fact-checking verification: sourced claims and fabrication detection."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vincera.core.llm import OpenRouterClient

from vincera.verification.verifier import CheckResult


async def fact_check(action: dict, llm: "OpenRouterClient") -> CheckResult:
    """Check that every factual claim in the action has a verifiable data source."""
    description = action.get("description", "")
    data_sources = action.get("data_sources", [])

    prompt = (
        "List every factual claim in this action plan. For each, identify the "
        "specific data source (file path, DB table, process name, API response). "
        "Flag any claim without a verifiable source.\n\n"
        f"Action: {description}\n"
        f"Cited data sources: {data_sources}\n\n"
        "If any claim lacks a verifiable source, start your response with 'FLAGGED:' "
        "and list the unsourced claims.\n"
        "If all claims are properly sourced, start with 'ALL_CLEAR:'."
    )

    response = await llm.think(
        system_prompt="You are a fact-checking reviewer. Verify data sources for every claim.",
        user_message=prompt,
    )

    if response.strip().upper().startswith("FLAGGED"):
        return CheckResult(
            name="fact_check",
            passed=False,
            reason=response.strip(),
        )

    return CheckResult(
        name="fact_check",
        passed=True,
        reason="All factual claims have verifiable sources.",
    )


async def no_fabrication(action: dict, llm: "OpenRouterClient") -> CheckResult:
    """Check if any data values in the action appear to be invented."""
    description = action.get("description", "")
    data_sources = action.get("data_sources", [])

    prompt = (
        "Check if any numbers, statistics, file names, or data values in this action "
        "appear to be invented rather than sourced from real data. "
        "Flag anything suspicious.\n\n"
        f"Action: {description}\n"
        f"Cited data sources: {data_sources}\n\n"
        "If fabrication is detected, start your response with 'FLAGGED:' and explain.\n"
        "If everything appears genuine, start with 'ALL_CLEAR:'."
    )

    response = await llm.think(
        system_prompt="You are a data integrity reviewer. Detect fabricated or invented data.",
        user_message=prompt,
    )

    if response.strip().upper().startswith("FLAGGED"):
        return CheckResult(
            name="no_fabrication",
            passed=False,
            reason=response.strip(),
        )

    return CheckResult(
        name="no_fabrication",
        passed=True,
        reason="No fabricated data detected.",
    )
