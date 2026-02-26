"""Confidence scoring for verification results."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vincera.verification.verifier import CheckResult


def calculate_confidence(checks: list[CheckResult], action: dict) -> float:
    """Calculate a confidence score from check results and action metadata.

    Base score: 1.0
    - Subtract 0.15 for each failed check
    - Subtract 0.10 if action has no cited data sources
    - Subtract 0.05 if action complexity is "high"
    Floor at 0.0, cap at 1.0.
    """
    score = 1.0

    for check in checks:
        if not check.passed:
            score -= 0.15

    if not action.get("data_sources"):
        score -= 0.10

    if action.get("complexity") == "high":
        score -= 0.05

    return max(0.0, min(1.0, score))
