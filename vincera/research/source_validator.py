"""Source validator: scores research source credibility."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TRUSTED_PUBLISHERS: frozenset[str] = frozenset({
    # Academic publishers
    "elsevier", "springer", "ieee", "acm", "wiley", "taylor & francis",
    "sage", "oxford university press", "cambridge university press", "mit press",
    # Consulting firms
    "mckinsey", "bcg", "bain", "deloitte", "accenture", "pwc", "ey", "kpmg",
    # Business journals
    "harvard business review", "mit sloan management review",
    "stanford business", "wharton", "journal of operations management",
    # Government / institutional
    "bureau of labor statistics", "world bank", "imf", "oecd",
    "european commission",
    # Industry analysts
    "gartner", "forrester", "idc", "statista",
})

REJECTED_TYPES: frozenset[str] = frozenset({
    "blog", "blog_post", "forum", "social_media", "reddit", "quora",
    "medium_post", "seo_content", "press_release", "sponsored_content",
})


class SourceValidator:
    """Validates research source credibility and assigns quality scores."""

    def validate(self, source: dict) -> dict:
        """Score a source 0.0–1.0 and return enriched copy.

        Adds ``quality_score`` and ``validation_reason`` keys.
        """
        score = 0.5
        reasons: list[str] = []

        publication = (source.get("publication") or "").lower()
        source_type = (source.get("source_type") or "").lower()
        authors = source.get("authors")
        year = source.get("year")

        # Trusted publisher bonus
        if any(pub in publication for pub in TRUSTED_PUBLISHERS):
            score += 0.3
            reasons.append("trusted publisher")

        # Academic / industry report bonus
        if source_type in ("academic_paper", "industry_report"):
            score += 0.1
            reasons.append(f"credible source type: {source_type}")

        # Recency bonus
        if year is not None and year >= 2018:
            score += 0.1
            reasons.append("recent research")

        # Rejected type penalty
        if source_type in REJECTED_TYPES:
            score -= 0.5
            reasons.append(f"rejected source type: {source_type}")

        # No authors penalty
        if not authors:
            score -= 0.2
            reasons.append("no authors listed")

        # No year penalty
        if year is None:
            score -= 0.1
            reasons.append("no year listed")

        score = max(0.0, min(1.0, score))

        result = {**source}
        result["quality_score"] = round(score, 2)
        result["validation_reason"] = "; ".join(reasons) if reasons else "baseline score"
        return result

    def filter_quality(self, sources: list[dict], threshold: float = 0.7) -> list[dict]:
        """Return only sources with quality_score >= threshold."""
        return [s for s in sources if s.get("quality_score", 0.0) >= threshold]
