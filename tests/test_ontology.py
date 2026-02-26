"""Tests for vincera.core.ontology — BusinessOntology and OntologyMapping."""

from __future__ import annotations

from vincera.core.ontology import BusinessOntology, OntologyMapping
from vincera.discovery.company_model import CompanyModel


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ontology() -> BusinessOntology:
    return BusinessOntology()


def _ecommerce_model() -> CompanyModel:
    return CompanyModel(
        business_type="ecommerce",
        industry="retail",
        confidence=0.85,
        software_stack=[
            {"name": "QuickBooks", "category": "accounting", "role": "finance"},
            {"name": "Shopify", "category": "ecommerce", "role": "storefront"},
        ],
        detected_processes=[
            {"name": "invoicing", "manual": True, "frequency": "daily", "evidence": "spreadsheet"},
            {"name": "order_processing", "manual": False, "frequency": "continuous", "evidence": "Shopify"},
        ],
        automation_opportunities=[],
        pain_points=["manual invoicing", "inventory sync"],
        risk_areas=[],
        key_findings=[],
    )


# ===========================================================================
# DOMAINS structure tests
# ===========================================================================

class TestDomains:
    def test_domains_count(self):
        ont = _ontology()
        assert len(ont.DOMAINS) >= 10

    def test_each_domain_has_required_keys(self):
        ont = _ontology()
        required = {"processes", "common_tools", "automation_patterns", "key_metrics"}
        for name, domain in ont.DOMAINS.items():
            missing = required - set(domain.keys())
            assert not missing, f"Domain '{name}' missing keys: {missing}"

    def test_each_domain_processes_nonempty(self):
        ont = _ontology()
        for name, domain in ont.DOMAINS.items():
            assert len(domain["processes"]) >= 3, f"Domain '{name}' has < 3 processes"


# ===========================================================================
# BUSINESS_TYPES structure tests
# ===========================================================================

class TestBusinessTypes:
    def test_business_types_count(self):
        ont = _ontology()
        assert len(ont.BUSINESS_TYPES) >= 12

    def test_each_business_type_has_required_keys(self):
        ont = _ontology()
        required = {"primary_domains", "typical_pain_points", "high_value_automations"}
        for name, btype in ont.BUSINESS_TYPES.items():
            missing = required - set(btype.keys())
            assert not missing, f"Business type '{name}' missing keys: {missing}"

    def test_business_type_domains_reference_valid_domains(self):
        ont = _ontology()
        valid_domains = set(ont.DOMAINS.keys())
        for name, btype in ont.BUSINESS_TYPES.items():
            for domain in btype["primary_domains"]:
                assert domain in valid_domains, (
                    f"Business type '{name}' references invalid domain '{domain}'"
                )


# ===========================================================================
# map_company tests
# ===========================================================================

class TestMapCompany:
    def test_ecommerce(self):
        ont = _ontology()
        mapping = ont.map_company(_ecommerce_model())
        assert isinstance(mapping, OntologyMapping)
        assert "finance" in mapping.matched_domains

    def test_detects_software(self):
        ont = _ontology()
        model = CompanyModel(
            business_type="unknown",
            software_stack=[{"name": "Salesforce", "category": "crm", "role": "sales"}],
        )
        mapping = ont.map_company(model)
        assert "sales" in mapping.matched_domains

    def test_identifies_gaps(self):
        ont = _ontology()
        # ecommerce primary_domains includes inventory, but no inventory tools or processes
        model = CompanyModel(
            business_type="ecommerce",
            software_stack=[{"name": "QuickBooks", "category": "accounting", "role": "finance"}],
            detected_processes=[{"name": "invoicing", "manual": True, "frequency": "daily", "evidence": "spreadsheet"}],
        )
        mapping = ont.map_company(model)
        gap_domains = [g["domain"] for g in mapping.identified_gaps]
        assert "inventory" in gap_domains


# ===========================================================================
# suggest_automations tests
# ===========================================================================

class TestSuggestAutomations:
    def test_returns_sorted(self):
        ont = _ontology()
        mapping = ont.map_company(_ecommerce_model())
        suggestions = ont.suggest_automations(mapping)
        assert isinstance(suggestions, list)
        assert len(suggestions) > 0
        # High priority items should come first
        priorities = [s["priority"] for s in suggestions]
        priority_order = {"high": 0, "medium": 1, "low": 2}
        numeric = [priority_order.get(p, 3) for p in priorities]
        assert numeric == sorted(numeric)

    def test_deduplicates(self):
        ont = _ontology()
        mapping = ont.map_company(_ecommerce_model())
        suggestions = ont.suggest_automations(mapping)
        names = [s["name"] for s in suggestions]
        assert len(names) == len(set(names)), "Duplicate automation names found"


# ===========================================================================
# get_context_for_agent tests
# ===========================================================================

class TestGetContextForAgent:
    def test_returns_relevant_info(self):
        ont = _ontology()
        mapping = ont.map_company(_ecommerce_model())
        ctx = ont.get_context_for_agent("discovery", mapping)
        assert isinstance(ctx, str)
        assert "finance" in ctx.lower()
        # Should not contain ALL domains — only matched ones
        unmatched = [d for d in ont.DOMAINS if d not in mapping.matched_domains]
        if unmatched:
            # At least one unmatched domain should not appear as a section header
            assert not all(d in ctx for d in unmatched)
