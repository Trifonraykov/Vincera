"""Safety verification checks: reversibility and idempotency."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vincera.core.llm import OpenRouterClient

from vincera.verification.verifier import CheckResult

# Destructive patterns (case-insensitive)
_DESTRUCTIVE_PATTERNS = [
    r"\bDELETE\b",
    r"\bDROP\b",
    r"\bTRUNCATE\b",
    r"\brm\s+-rf\b",
    r"\brm\s+-r\b",
    r"\bdel\s+/f\b",
    r"\bformat\b",
    r"\boverwrite\b",
    r"\bDESTROY\b",
]

# External communication patterns
_EXTERNAL_PATTERNS = [
    r"\bSMTP\b",
    r"\bsmtp\b",
    r"\bsendmail\b",
    r"\bPOST\s+https?://(?!.*supabase)",  # HTTP POST to non-Supabase URLs
    r"\bwebhook\b(?!.*supabase)",
]

# Financial patterns
_FINANCIAL_PATTERNS = [
    r"\bpayment\b",
    r"\btransfer\b",
    r"\bcharge\b",
    r"\binvoice_create\b",
    r"\btransaction\b",
]

_ALL_PATTERNS = _DESTRUCTIVE_PATTERNS + _EXTERNAL_PATTERNS + _FINANCIAL_PATTERNS


async def reversibility_check(action: dict, llm: "OpenRouterClient") -> CheckResult:
    """Rule-based reversibility check. No LLM call needed.

    Scans action description and commands for destructive, external, or financial patterns.
    """
    text_to_scan = " ".join([
        action.get("description", ""),
        " ".join(action.get("commands", [])),
    ])

    for pattern in _ALL_PATTERNS:
        match = re.search(pattern, text_to_scan, re.IGNORECASE)
        if match:
            matched_text = match.group(0).strip()
            return CheckResult(
                name="reversibility",
                passed=False,
                reason=f"Irreversible or risky pattern detected: '{matched_text}'",
            )

    return CheckResult(
        name="reversibility",
        passed=True,
        reason="No destructive, external, or financial patterns detected.",
    )


async def idempotency_check(action: dict, llm: "OpenRouterClient") -> CheckResult:
    """LLM-based idempotency check.

    Asks Claude whether the action could accidentally process data twice.
    """
    description = action.get("description", "")
    commands = " ".join(action.get("commands", []))

    prompt = (
        "Could this action accidentally process the same data twice? "
        "Could it duplicate records, send duplicate emails, or create duplicate files? "
        "Analyze for idempotency risks.\n\n"
        f"Action: {description}\n"
        f"Commands: {commands}\n\n"
        "If there is an idempotency risk, start your response with 'FLAGGED:' and explain.\n"
        "If the action is idempotent or safe, start with 'ALL_CLEAR:'."
    )

    response = await llm.think(
        system_prompt="You are a safety reviewer checking for idempotency risks.",
        user_message=prompt,
    )

    if response.strip().upper().startswith("FLAGGED"):
        return CheckResult(
            name="idempotency",
            passed=False,
            reason=response.strip(),
        )

    return CheckResult(
        name="idempotency",
        passed=True,
        reason="No idempotency risks detected.",
    )
