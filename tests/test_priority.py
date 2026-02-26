"""Tests for vincera.core.priority — PriorityEngine."""

from __future__ import annotations

from vincera.core.priority import AutomationCandidate, PriorityEngine


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_candidate(**overrides) -> AutomationCandidate:
    """Create an AutomationCandidate with sensible defaults."""
    defaults = dict(
        name="auto_invoicing",
        domain="finance",
        description="Automate invoice generation",
        source="ontology",
        evidence="business type match",
    )
    defaults.update(overrides)
    return AutomationCandidate(**defaults)


def _engine() -> PriorityEngine:
    return PriorityEngine()


# ===========================================================================
# score_impact tests
# ===========================================================================

class TestScoreImpact:
    def test_high_hours(self) -> None:
        c = _make_candidate(
            estimated_hours_saved_weekly=20.0,
            current_process_exists=True,
            source="discovery",
        )
        score, bd = _engine().score_impact(c)
        assert score >= 0.9

    def test_zero_hours(self) -> None:
        c = _make_candidate(
            estimated_hours_saved_weekly=0.0,
            current_process_exists=False,
            source="ontology",
        )
        score, bd = _engine().score_impact(c)
        assert score < 0.1

    def test_process_exists_bonus(self) -> None:
        base = _make_candidate(estimated_hours_saved_weekly=5.0)
        with_process = _make_candidate(estimated_hours_saved_weekly=5.0, current_process_exists=True)
        score_without, _ = _engine().score_impact(base)
        score_with, _ = _engine().score_impact(with_process)
        assert score_with > score_without

    def test_discovery_bonus(self) -> None:
        discovery = _make_candidate(source="discovery", estimated_hours_saved_weekly=5.0)
        ontology = _make_candidate(source="ontology", estimated_hours_saved_weekly=5.0)
        score_disc, _ = _engine().score_impact(discovery)
        score_ont, _ = _engine().score_impact(ontology)
        assert score_disc > score_ont


# ===========================================================================
# score_feasibility tests
# ===========================================================================

class TestScoreFeasibility:
    def test_trivial(self) -> None:
        c = _make_candidate(estimated_complexity="trivial")
        score, _ = _engine().score_feasibility(c)
        assert score == 1.0

    def test_extreme(self) -> None:
        c = _make_candidate(estimated_complexity="extreme")
        score, _ = _engine().score_feasibility(c)
        assert score < 0.3

    def test_api_penalty(self) -> None:
        without_api = _make_candidate(estimated_complexity="medium")
        with_api = _make_candidate(estimated_complexity="medium", requires_external_api=True)
        score_without, _ = _engine().score_feasibility(without_api)
        score_with, _ = _engine().score_feasibility(with_api)
        assert score_with < score_without


# ===========================================================================
# score_risk tests
# ===========================================================================

class TestScoreRisk:
    def test_safe(self) -> None:
        c = _make_candidate()
        score, _ = _engine().score_risk(c)
        assert score == 0.0

    def test_financial(self) -> None:
        c = _make_candidate(affects_financial_data=True)
        score, _ = _engine().score_risk(c)
        assert abs(score - 0.30) < 0.001

    def test_irreversible(self) -> None:
        c = _make_candidate(reversible=False)
        score, _ = _engine().score_risk(c)
        assert abs(score - 0.35) < 0.001

    def test_cumulative(self) -> None:
        c = _make_candidate(
            requires_external_api=True,       # 0.15
            requires_data_access=True,         # 0.10
            requires_system_modification=True,  # 0.25
            affects_financial_data=True,        # 0.30
            affects_customer_data=True,         # 0.20
            reversible=False,                   # 0.35
        )
        score, _ = _engine().score_risk(c)
        # Sum = 1.35, clamped to 1.0
        assert score == 1.0


# ===========================================================================
# score (final) tests
# ===========================================================================

class TestScoreFinal:
    def test_high_impact_low_risk(self) -> None:
        c = _make_candidate(
            estimated_hours_saved_weekly=20.0,
            current_process_exists=True,
            source="discovery",
            estimated_complexity="trivial",
        )
        scored = _engine().score(c)
        assert scored.final_score > 0.6

    def test_low_impact_high_risk(self) -> None:
        c = _make_candidate(
            estimated_hours_saved_weekly=0.5,
            estimated_complexity="extreme",
            affects_financial_data=True,
            affects_customer_data=True,
            reversible=False,
        )
        scored = _engine().score(c)
        assert scored.final_score < 0.2

    def test_priority_labels(self) -> None:
        engine = _engine()
        # Build candidates with known characteristics to hit each label
        critical = _make_candidate(
            estimated_hours_saved_weekly=20.0,
            current_process_exists=True,
            source="discovery",
            estimated_complexity="trivial",
        )
        low = _make_candidate(
            estimated_hours_saved_weekly=1.0,
            estimated_complexity="high",
            affects_financial_data=True,
        )
        scored_c = engine.score(critical)
        scored_l = engine.score(low)
        assert scored_c.priority in ("critical", "high")
        assert scored_l.priority in ("low", "backlog")


# ===========================================================================
# rank tests
# ===========================================================================

class TestRank:
    def test_sorted(self) -> None:
        engine = _engine()
        candidates = [
            _make_candidate(name="low", estimated_hours_saved_weekly=0.5, estimated_complexity="extreme"),
            _make_candidate(name="high", estimated_hours_saved_weekly=15.0, estimated_complexity="trivial"),
            _make_candidate(name="mid", estimated_hours_saved_weekly=5.0, estimated_complexity="medium"),
        ]
        ranked = engine.rank(candidates)
        assert len(ranked) == 3
        assert ranked[0].final_score >= ranked[1].final_score >= ranked[2].final_score
        assert ranked[0].candidate.name == "high"


# ===========================================================================
# merge_candidates tests
# ===========================================================================

class TestMergeCandidates:
    def test_deduplicates(self) -> None:
        engine = _engine()
        ontology = [{"name": "Auto Invoice", "domain": "finance", "priority": "high", "evidence": "type match"}]
        research = [{"insight": "Auto Invoice", "category": "finance", "actionability": "high", "how_to_apply": "use API"}]
        merged = engine.merge_candidates(ontology, research, [])
        # Same name (case-insensitive) → 1 entry
        names = [c.name.lower() for c in merged]
        assert names.count("auto invoice") == 1

    def test_source_priority(self) -> None:
        engine = _engine()
        ontology = [{"name": "Auto Invoice", "domain": "finance", "priority": "high", "evidence": "type match"}]
        research = [{"insight": "Auto Invoice", "category": "finance", "actionability": "high", "how_to_apply": "use API"}]
        discovery = [{"name": "Auto Invoice", "description": "Generate invoices automatically", "estimated_hours_saved": 10.0}]
        merged = engine.merge_candidates(ontology, research, discovery)
        assert len(merged) == 1
        assert merged[0].source == "discovery"


# ===========================================================================
# get_next_batch tests
# ===========================================================================

class TestGetNextBatch:
    def test_excludes_backlog(self) -> None:
        engine = _engine()
        candidates = [
            _make_candidate(name="great", estimated_hours_saved_weekly=15.0, estimated_complexity="trivial"),
            _make_candidate(name="good", estimated_hours_saved_weekly=8.0, estimated_complexity="low"),
            _make_candidate(name="ok", estimated_hours_saved_weekly=4.0, estimated_complexity="medium"),
            _make_candidate(name="bad1", estimated_hours_saved_weekly=0.1, estimated_complexity="extreme",
                           affects_financial_data=True, reversible=False),
            _make_candidate(name="bad2", estimated_hours_saved_weekly=0.1, estimated_complexity="extreme",
                           affects_customer_data=True, reversible=False),
        ]
        ranked = engine.rank(candidates)
        batch = engine.get_next_batch(ranked, batch_size=3)
        for item in batch:
            assert item.priority != "backlog"

    def test_respects_size(self) -> None:
        engine = _engine()
        candidates = [
            _make_candidate(name=f"auto_{i}", estimated_hours_saved_weekly=10.0, estimated_complexity="low")
            for i in range(5)
        ]
        ranked = engine.rank(candidates)
        batch = engine.get_next_batch(ranked, batch_size=2)
        assert len(batch) <= 2
