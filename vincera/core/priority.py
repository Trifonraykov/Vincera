"""Priority Engine — scores and ranks automation candidates.

Pure deterministic scoring: no LLM calls, no external I/O.
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class AutomationCandidate(BaseModel):
    """A potential automation opportunity from any source."""

    name: str
    domain: str
    description: str
    source: str  # "ontology", "research", "discovery", "user_request"
    evidence: str
    estimated_hours_saved_weekly: float = 0.0
    estimated_complexity: str = "medium"
    requires_external_api: bool = False
    requires_data_access: bool = False
    requires_system_modification: bool = False
    affects_financial_data: bool = False
    affects_customer_data: bool = False
    reversible: bool = True
    current_process_exists: bool = False


class ScoredCandidate(BaseModel):
    """A candidate with computed scores and priority label."""

    candidate: AutomationCandidate
    impact_score: float = Field(ge=0.0, le=1.0)
    feasibility_score: float = Field(ge=0.0, le=1.0)
    risk_score: float = Field(ge=0.0, le=1.0)
    final_score: float = Field(ge=0.0, le=1.0)
    priority: str  # "critical", "high", "medium", "low", "backlog"
    scoring_breakdown: dict


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

class PriorityEngine:
    """Deterministic scoring engine for automation candidates."""

    COMPLEXITY_MULTIPLIERS: dict[str, float] = {
        "trivial": 1.0,
        "low": 0.9,
        "medium": 0.7,
        "high": 0.4,
        "extreme": 0.15,
    }

    RISK_WEIGHTS: dict[str, float] = {
        "requires_external_api": 0.15,
        "requires_data_access": 0.10,
        "requires_system_modification": 0.25,
        "affects_financial_data": 0.30,
        "affects_customer_data": 0.20,
        "not_reversible": 0.35,
    }

    # ---- Impact ----

    def score_impact(self, candidate: AutomationCandidate) -> tuple[float, dict]:
        hours_component = min(candidate.estimated_hours_saved_weekly / 20.0, 1.0)
        process_exists_bonus = 0.2 if candidate.current_process_exists else 0.0
        evidence_bonus = (
            0.1 if candidate.source == "discovery"
            else 0.05 if candidate.source == "research"
            else 0.0
        )
        raw = hours_component * 0.7 + process_exists_bonus + evidence_bonus
        score = max(0.0, min(raw, 1.0))
        breakdown = {
            "hours_component": hours_component,
            "process_exists_bonus": process_exists_bonus,
            "evidence_bonus": evidence_bonus,
            "raw": raw,
        }
        return score, breakdown

    # ---- Feasibility ----

    def score_feasibility(self, candidate: AutomationCandidate) -> tuple[float, dict]:
        base = self.COMPLEXITY_MULTIPLIERS.get(candidate.estimated_complexity, 0.7)
        api_penalty = -0.1 if candidate.requires_external_api else 0.0
        system_mod_penalty = -0.15 if candidate.requires_system_modification else 0.0
        score = max(base + api_penalty + system_mod_penalty, 0.05)
        breakdown = {
            "base": base,
            "api_penalty": api_penalty,
            "system_mod_penalty": system_mod_penalty,
        }
        return score, breakdown

    # ---- Risk ----

    def score_risk(self, candidate: AutomationCandidate) -> tuple[float, dict]:
        breakdown: dict[str, float] = {}
        total = 0.0

        flag_map = {
            "requires_external_api": candidate.requires_external_api,
            "requires_data_access": candidate.requires_data_access,
            "requires_system_modification": candidate.requires_system_modification,
            "affects_financial_data": candidate.affects_financial_data,
            "affects_customer_data": candidate.affects_customer_data,
            "not_reversible": not candidate.reversible,
        }

        for key, active in flag_map.items():
            weight = self.RISK_WEIGHTS[key]
            if active:
                total += weight
                breakdown[key] = weight
            else:
                breakdown[key] = 0.0

        score = max(0.0, min(total, 1.0))
        return score, breakdown

    # ---- Combined ----

    def score(self, candidate: AutomationCandidate) -> ScoredCandidate:
        impact, impact_bd = self.score_impact(candidate)
        feasibility, feas_bd = self.score_feasibility(candidate)
        risk, risk_bd = self.score_risk(candidate)

        final = (impact * 0.45 + feasibility * 0.35) * (1.0 - risk * 0.5)

        if final >= 0.8:
            priority = "critical"
        elif final >= 0.6:
            priority = "high"
        elif final >= 0.4:
            priority = "medium"
        elif final >= 0.2:
            priority = "low"
        else:
            priority = "backlog"

        return ScoredCandidate(
            candidate=candidate,
            impact_score=impact,
            feasibility_score=feasibility,
            risk_score=risk,
            final_score=round(final, 6),
            priority=priority,
            scoring_breakdown={
                "impact": impact_bd,
                "feasibility": feas_bd,
                "risk": risk_bd,
            },
        )

    # ---- Ranking ----

    def rank(self, candidates: list[AutomationCandidate]) -> list[ScoredCandidate]:
        scored = [self.score(c) for c in candidates]
        scored.sort(key=lambda s: s.final_score, reverse=True)
        return scored

    # ---- Merging ----

    def merge_candidates(
        self,
        ontology_suggestions: list[dict],
        research_insights: list[dict],
        discovery_opportunities: list[dict],
    ) -> list[AutomationCandidate]:
        """Merge candidates from multiple sources, deduplicating by name."""

        SOURCE_RANK = {"discovery": 3, "research": 2, "ontology": 1, "user_request": 0}

        # key: lowercase name → (source_rank, AutomationCandidate)
        merged: dict[str, tuple[int, AutomationCandidate]] = {}

        def _upsert(candidate: AutomationCandidate) -> None:
            key = candidate.name.lower()
            rank = SOURCE_RANK.get(candidate.source, 0)
            existing = merged.get(key)
            if existing is None:
                merged[key] = (rank, candidate)
            else:
                old_rank, old_cand = existing
                if rank > old_rank:
                    # Keep higher-authority source, take max hours
                    hours = max(candidate.estimated_hours_saved_weekly, old_cand.estimated_hours_saved_weekly)
                    updated = candidate.model_copy(update={"estimated_hours_saved_weekly": hours})
                    merged[key] = (rank, updated)
                elif rank == old_rank:
                    hours = max(candidate.estimated_hours_saved_weekly, old_cand.estimated_hours_saved_weekly)
                    updated = old_cand.model_copy(update={"estimated_hours_saved_weekly": hours})
                    merged[key] = (old_rank, updated)
                else:
                    # Existing has higher rank — just take max hours
                    hours = max(candidate.estimated_hours_saved_weekly, old_cand.estimated_hours_saved_weekly)
                    updated = old_cand.model_copy(update={"estimated_hours_saved_weekly": hours})
                    merged[key] = (old_rank, updated)

        # Convert ontology suggestions
        for s in ontology_suggestions:
            _upsert(AutomationCandidate(
                name=s.get("name", "unknown"),
                domain=s.get("domain", "general"),
                description=s.get("description", s.get("name", "")),
                source="ontology",
                evidence=s.get("evidence", "business type match"),
                estimated_hours_saved_weekly=float(s.get("estimated_hours_saved", 0)),
            ))

        # Convert research insights
        for r in research_insights:
            _upsert(AutomationCandidate(
                name=r.get("insight", r.get("name", "unknown")),
                domain=r.get("category", "general"),
                description=r.get("how_to_apply", r.get("insight", "")),
                source="research",
                evidence=f"research: actionability={r.get('actionability', 'unknown')}",
                estimated_hours_saved_weekly=float(r.get("estimated_hours_saved", 0)),
            ))

        # Convert discovery opportunities
        for d in discovery_opportunities:
            _upsert(AutomationCandidate(
                name=d.get("name", "unknown"),
                domain=d.get("domain", "general"),
                description=d.get("description", ""),
                source="discovery",
                evidence=d.get("evidence", "discovered in environment"),
                estimated_hours_saved_weekly=float(d.get("estimated_hours_saved", 0)),
                estimated_complexity=d.get("complexity", "medium"),
                current_process_exists=True,
            ))

        return [cand for _, cand in merged.values()]

    # ---- Batch ----

    def get_next_batch(
        self,
        ranked: list[ScoredCandidate],
        batch_size: int = 3,
    ) -> list[ScoredCandidate]:
        """Return top N non-backlog candidates."""
        return [s for s in ranked if s.priority != "backlog"][:batch_size]
