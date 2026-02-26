"""Authority Manager — controls what the agent may do autonomously.

Defines authority levels, risk classification, and approval workflows.
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.agents.base import BaseAgent
    from vincera.knowledge.supabase_client import SupabaseManager

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class AuthorityLevel(str, Enum):
    OBSERVER = "observer"
    SUGGEST = "suggest"
    ASK_ALWAYS = "ask_always"
    ASK_RISKY = "ask_risky"
    ASK_HIGH_ONLY = "ask_high_only"
    AUTONOMOUS = "autonomous"


class ActionRiskLevel(str, Enum):
    SAFE = "safe"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


# ---------------------------------------------------------------------------
# Decision model
# ---------------------------------------------------------------------------

class AuthorityDecision(BaseModel):
    action: str
    risk_level: ActionRiskLevel
    authority_level: AuthorityLevel
    auto_approved: bool
    requires_approval: bool
    reason: str


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------

class AuthorityManager:
    """Manages authority levels and approval workflows."""

    # True = requires approval at that (authority_level, risk_level) pair
    APPROVAL_MATRIX: dict[AuthorityLevel, dict[ActionRiskLevel, bool]] = {
        AuthorityLevel.OBSERVER: {
            ActionRiskLevel.SAFE: True,
            ActionRiskLevel.LOW: True,
            ActionRiskLevel.MEDIUM: True,
            ActionRiskLevel.HIGH: True,
            ActionRiskLevel.CRITICAL: True,
        },
        AuthorityLevel.SUGGEST: {
            ActionRiskLevel.SAFE: True,
            ActionRiskLevel.LOW: True,
            ActionRiskLevel.MEDIUM: True,
            ActionRiskLevel.HIGH: True,
            ActionRiskLevel.CRITICAL: True,
        },
        AuthorityLevel.ASK_ALWAYS: {
            ActionRiskLevel.SAFE: True,
            ActionRiskLevel.LOW: True,
            ActionRiskLevel.MEDIUM: True,
            ActionRiskLevel.HIGH: True,
            ActionRiskLevel.CRITICAL: True,
        },
        AuthorityLevel.ASK_RISKY: {
            ActionRiskLevel.SAFE: False,
            ActionRiskLevel.LOW: True,
            ActionRiskLevel.MEDIUM: True,
            ActionRiskLevel.HIGH: True,
            ActionRiskLevel.CRITICAL: True,
        },
        AuthorityLevel.ASK_HIGH_ONLY: {
            ActionRiskLevel.SAFE: False,
            ActionRiskLevel.LOW: False,
            ActionRiskLevel.MEDIUM: False,
            ActionRiskLevel.HIGH: True,
            ActionRiskLevel.CRITICAL: True,
        },
        AuthorityLevel.AUTONOMOUS: {
            ActionRiskLevel.SAFE: False,
            ActionRiskLevel.LOW: False,
            ActionRiskLevel.MEDIUM: False,
            ActionRiskLevel.HIGH: False,
            ActionRiskLevel.CRITICAL: True,
        },
    }

    def __init__(self, supabase: SupabaseManager, company_id: str) -> None:
        self._sb = supabase
        self._company_id = company_id

    # ---- Properties ----

    @property
    def authority_level(self) -> AuthorityLevel:
        """Load authority level from company record (default ASK_RISKY)."""
        company = self._sb.get_company(self._company_id)
        if company:
            raw = company.get("authority_level", "ask_risky")
            try:
                return AuthorityLevel(raw)
            except ValueError:
                logger.warning("Unknown authority level %r, defaulting to ask_risky", raw)
        return AuthorityLevel.ASK_RISKY

    # ---- Risk classification ----

    def classify_risk(
        self,
        action_description: str,
        affects_financial: bool = False,
        affects_customer: bool = False,
        is_reversible: bool = True,
        modifies_system: bool = False,
        is_bulk: bool = False,
    ) -> ActionRiskLevel:
        """Deterministic risk classification."""
        # CRITICAL
        if is_bulk and (affects_financial or affects_customer):
            return ActionRiskLevel.CRITICAL
        if modifies_system and not is_reversible:
            return ActionRiskLevel.CRITICAL

        # HIGH
        if affects_financial or affects_customer:
            return ActionRiskLevel.HIGH
        if modifies_system and is_reversible:
            return ActionRiskLevel.HIGH

        # MEDIUM
        if not is_reversible:
            return ActionRiskLevel.MEDIUM

        # LOW — bulk internal operations that are reversible but non-trivial
        if is_bulk:
            return ActionRiskLevel.LOW

        # SAFE — read-only, reporting, internal analysis (default)
        return ActionRiskLevel.SAFE

    # ---- Authority check ----

    def check_authority(self, action: str, risk_level: ActionRiskLevel) -> AuthorityDecision:
        """Check whether this action is auto-approved at the current authority level."""
        level = self.authority_level
        requires = self.APPROVAL_MATRIX[level][risk_level]
        reason = (
            f"Authority level '{level.value}' requires approval for '{risk_level.value}' actions"
            if requires
            else f"Authority level '{level.value}' auto-approves '{risk_level.value}' actions"
        )
        return AuthorityDecision(
            action=action,
            risk_level=risk_level,
            authority_level=level,
            auto_approved=not requires,
            requires_approval=requires,
            reason=reason,
        )

    # ---- Request if needed ----

    async def request_if_needed(
        self,
        agent: BaseAgent,
        action: str,
        risk_level: ActionRiskLevel,
        context: str = "",
    ) -> bool:
        """Auto-approve or ask the user depending on authority level."""
        decision = self.check_authority(action, risk_level)

        if decision.auto_approved:
            self._sb.log_event(
                self._company_id,
                "authority",
                f"auto_approved: {action}",
                {"risk_level": risk_level.value, "authority_level": decision.authority_level.value},
            )
            return True

        approval = await agent.request_approval(
            question=f"May I proceed with: {action}?",
            option_a="Approve",
            option_b="Deny",
            context=f"Risk: {risk_level.value}. {context}",
            risk_level=risk_level.value,
        )

        approved = approval == "option_a"
        self._sb.log_event(
            self._company_id,
            "authority",
            f"user_{'approved' if approved else 'denied'}: {action}",
            {"risk_level": risk_level.value, "user_response": approval},
        )
        return approved

    # ---- Set level ----

    async def set_level(self, level: AuthorityLevel) -> None:
        """Update the company's authority level."""
        self._sb.update_company(self._company_id, {"authority_level": level.value})
        self._sb.send_message(
            self._company_id,
            "system",
            f"Authority level changed to: {level.value}",
            "system",
        )

    # ---- Helpers ----

    def can_act(self) -> bool:
        """Return False if authority level is OBSERVER or SUGGEST."""
        return self.authority_level not in (AuthorityLevel.OBSERVER, AuthorityLevel.SUGGEST)

    def get_restrictions_summary(self) -> str:
        """Return a human-readable summary of current restrictions."""
        level = self.authority_level
        matrix = self.APPROVAL_MATRIX[level]

        auto = [r.value for r, requires in matrix.items() if not requires]
        needs = [r.value for r, requires in matrix.items() if requires]

        lines = [f"Authority level: {level.value}"]
        if auto:
            lines.append(f"  Auto-approved: {', '.join(auto)}")
        if needs:
            lines.append(f"  Requires approval: {', '.join(needs)}")
        if not self.can_act():
            lines.append("  Note: Agent cannot take actions at this level.")
        return "\n".join(lines)
