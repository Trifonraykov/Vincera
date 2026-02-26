"""Core verifier: orchestrates the 6-check verification pipeline."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vincera.core.llm import OpenRouterClient

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Data classes
# ------------------------------------------------------------------


@dataclass
class CheckResult:
    """Result of a single verification check."""

    name: str
    passed: bool
    reason: str


@dataclass
class VerificationResult:
    """Aggregated result of the full verification pipeline."""

    passed: bool
    checks: list[CheckResult] = field(default_factory=list)
    confidence: float = 0.0
    blocked_reason: str | None = None


# ------------------------------------------------------------------
# Verifier
# ------------------------------------------------------------------


class Verifier:
    """Orchestrates the 6-check verification pipeline."""

    def __init__(self, llm: "OpenRouterClient") -> None:
        self._llm = llm

    async def verify(self, action: dict, context: dict) -> VerificationResult:
        """Run all 6 checks sequentially. All must pass.

        Returns a VerificationResult with confidence score.
        If confidence < 0.7, the result is marked as failed.
        """
        from vincera.verification.confidence import calculate_confidence
        from vincera.verification.fact_checker import fact_check, no_fabrication
        from vincera.verification.safety import idempotency_check, reversibility_check

        checks: list[CheckResult] = []

        # 1. Fact check
        checks.append(await fact_check(action, self._llm))
        # 2. No fabrication
        checks.append(await no_fabrication(action, self._llm))
        # 3. Reversibility
        checks.append(await reversibility_check(action, self._llm))
        # 4. Idempotency
        checks.append(await idempotency_check(action, self._llm))
        # 5. Effectiveness (inline)
        checks.append(await self._effectiveness_check(action))
        # 6. Authority (inline)
        checks.append(await self._authority_check(action))

        confidence = calculate_confidence(checks, action)
        all_passed = all(c.passed for c in checks)

        if not all_passed or confidence < 0.7:
            blocked = None
            if confidence < 0.7:
                blocked = f"Confidence too low ({confidence:.2f}). Escalating to human."
            elif not all_passed:
                failed = [c.name for c in checks if not c.passed]
                blocked = f"Failed checks: {', '.join(failed)}"
            return VerificationResult(
                passed=False,
                checks=checks,
                confidence=confidence,
                blocked_reason=blocked,
            )

        return VerificationResult(
            passed=True,
            checks=checks,
            confidence=confidence,
            blocked_reason=None,
        )

    async def verify_high_stakes(self, action: dict, context: dict) -> VerificationResult:
        """Two independent Claude calls with different system prompts.

        Both must return ALL_CLEAR for the result to pass.
        """
        description = action.get("description", "")
        commands = " ".join(action.get("commands", []))
        user_msg = f"Action: {description}\nCommands: {commands}"

        # Reviewer A — cautious safety reviewer
        response_a = await self._llm.think(
            system_prompt=(
                "You are a cautious safety reviewer. Look for any possible risk, "
                "side effect, or unintended consequence in this action. "
                "If you find ANY risk, start with 'FLAGGED:'. "
                "If the action is safe, start with 'ALL_CLEAR:'."
            ),
            user_message=user_msg,
        )

        # Reviewer B — practical operations reviewer
        response_b = await self._llm.think(
            system_prompt=(
                "You are a practical operations reviewer. Verify this action is correct, "
                "properly scoped, and will achieve its intended goal without harm. "
                "If you find issues, start with 'FLAGGED:'. "
                "If the action is correct, start with 'ALL_CLEAR:'."
            ),
            user_message=user_msg,
        )

        a_passed = response_a.strip().upper().startswith("ALL_CLEAR")
        b_passed = response_b.strip().upper().startswith("ALL_CLEAR")

        check_a = CheckResult(name="high_stakes_safety", passed=a_passed, reason=response_a.strip())
        check_b = CheckResult(name="high_stakes_operations", passed=b_passed, reason=response_b.strip())

        if a_passed and b_passed:
            return VerificationResult(
                passed=True,
                checks=[check_a, check_b],
                confidence=1.0,
                blocked_reason=None,
            )

        if a_passed != b_passed:
            blocked = "Independent verifications disagreed. Human review needed."
        else:
            blocked = "Both independent reviewers flagged issues."

        return VerificationResult(
            passed=False,
            checks=[check_a, check_b],
            confidence=0.0,
            blocked_reason=blocked,
        )

    # ------------------------------------------------------------------
    # Inline checks
    # ------------------------------------------------------------------

    async def _effectiveness_check(self, action: dict) -> CheckResult:
        """Check if the action is likely to achieve its stated goal."""
        description = action.get("description", "")
        commands = " ".join(action.get("commands", []))

        response = await self._llm.think(
            system_prompt="You are an effectiveness reviewer. Determine if this action will achieve its goal.",
            user_message=(
                f"Action: {description}\nCommands: {commands}\n\n"
                "Will this action effectively achieve its stated goal? "
                "If there are effectiveness concerns, start with 'FLAGGED:'. "
                "If it should work as intended, start with 'ALL_CLEAR:'."
            ),
        )

        if response.strip().upper().startswith("FLAGGED"):
            return CheckResult(name="effectiveness", passed=False, reason=response.strip())

        return CheckResult(name="effectiveness", passed=True, reason="Action should achieve its goal.")

    async def _authority_check(self, action: dict) -> CheckResult:
        """Check if the action requires approval that hasn't been granted."""
        if action.get("requires_approval") and not action.get("approved"):
            return CheckResult(
                name="authority",
                passed=False,
                reason="Action requires approval but has not been approved.",
            )

        return CheckResult(
            name="authority",
            passed=True,
            reason="Action has appropriate authorization.",
        )
