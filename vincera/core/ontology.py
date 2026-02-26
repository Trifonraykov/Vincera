"""Business ontology: structured knowledge base of how businesses operate."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.discovery.company_model import CompanyModel

logger = logging.getLogger(__name__)


class OntologyMapping(BaseModel):
    """Result of mapping a CompanyModel onto the business ontology."""

    business_type: str = "unknown"
    matched_domains: list[str] = []
    active_tools_by_domain: dict[str, list[str]] = {}
    confirmed_processes: list[dict] = []
    suggested_automations: list[dict] = []
    identified_gaps: list[dict] = []


class BusinessOntology:
    """Hardcoded knowledge base of business domains and types."""

    DOMAINS: dict[str, dict] = {
        "finance": {
            "processes": [
                "invoicing", "accounts_payable", "accounts_receivable", "payroll",
                "budgeting", "tax_compliance", "financial_reporting",
                "expense_management", "cash_flow_management",
            ],
            "common_tools": [
                "QuickBooks", "Xero", "SAP", "NetSuite", "FreshBooks", "Sage", "Wave",
            ],
            "automation_patterns": [
                "auto_invoice_generation", "payment_reconciliation",
                "expense_categorization", "financial_report_generation",
                "payroll_processing",
            ],
            "key_metrics": [
                "days_sales_outstanding", "cash_conversion_cycle",
                "accounts_payable_turnover",
            ],
        },
        "sales": {
            "processes": [
                "lead_generation", "pipeline_management", "quoting",
                "order_processing", "crm_management", "commission_tracking",
                "sales_forecasting",
            ],
            "common_tools": [
                "Salesforce", "HubSpot", "Pipedrive", "Zoho CRM", "Close",
            ],
            "automation_patterns": [
                "lead_scoring", "follow_up_sequences", "quote_generation",
                "order_entry_automation", "commission_calculation",
            ],
            "key_metrics": [
                "conversion_rate", "average_deal_size", "sales_cycle_length",
            ],
        },
        "operations": {
            "processes": [
                "procurement", "vendor_management", "quality_control",
                "project_management", "resource_allocation", "process_optimization",
            ],
            "common_tools": [
                "Asana", "Jira", "Monday.com", "Trello", "Notion",
            ],
            "automation_patterns": [
                "purchase_order_generation", "vendor_evaluation",
                "task_assignment", "status_reporting",
            ],
            "key_metrics": [
                "operational_efficiency", "throughput", "cycle_time",
            ],
        },
        "hr": {
            "processes": [
                "recruiting", "onboarding", "performance_reviews",
                "time_tracking", "benefits_administration", "offboarding",
                "training",
            ],
            "common_tools": [
                "BambooHR", "Gusto", "ADP", "Workday", "Rippling",
            ],
            "automation_patterns": [
                "offer_letter_generation", "onboarding_checklist",
                "time_approval", "review_scheduling",
            ],
            "key_metrics": [
                "time_to_hire", "employee_turnover", "training_completion",
            ],
        },
        "procurement": {
            "processes": [
                "supplier_sourcing", "purchase_orders", "receiving",
                "invoice_matching", "contract_management",
            ],
            "common_tools": [
                "SAP Ariba", "Coupa", "Procurify",
            ],
            "automation_patterns": [
                "three_way_matching", "reorder_alerts", "supplier_scorecard",
            ],
            "key_metrics": [
                "purchase_order_cycle_time", "supplier_defect_rate",
            ],
        },
        "inventory": {
            "processes": [
                "stock_tracking", "reorder_management", "warehouse_organization",
                "demand_forecasting", "returns_processing",
            ],
            "common_tools": [
                "TradeGecko", "Cin7", "Fishbowl", "DEAR Inventory",
            ],
            "automation_patterns": [
                "low_stock_alerts", "auto_reorder",
                "inventory_reconciliation", "demand_forecast_reports",
            ],
            "key_metrics": [
                "inventory_turnover", "stockout_rate", "carrying_cost",
            ],
        },
        "customer_service": {
            "processes": [
                "ticket_management", "live_chat", "knowledge_base",
                "escalation", "feedback_collection", "sla_tracking",
            ],
            "common_tools": [
                "Zendesk", "Intercom", "Freshdesk", "Help Scout",
            ],
            "automation_patterns": [
                "auto_ticket_routing", "canned_responses",
                "sla_breach_alerts", "satisfaction_surveys",
            ],
            "key_metrics": [
                "first_response_time", "resolution_time", "csat_score",
            ],
        },
        "marketing": {
            "processes": [
                "campaign_management", "content_creation", "email_marketing",
                "social_media", "analytics", "seo",
            ],
            "common_tools": [
                "Mailchimp", "HubSpot Marketing", "Google Analytics",
                "Hootsuite", "SEMrush",
            ],
            "automation_patterns": [
                "email_sequences", "social_scheduling",
                "report_generation", "lead_nurturing",
            ],
            "key_metrics": [
                "customer_acquisition_cost", "conversion_rate", "roi_per_channel",
            ],
        },
        "compliance": {
            "processes": [
                "regulatory_tracking", "audit_preparation", "policy_management",
                "risk_assessment", "reporting",
            ],
            "common_tools": [
                "LogicGate", "ServiceNow GRC", "Drata", "Vanta",
            ],
            "automation_patterns": [
                "compliance_checklist", "audit_trail_generation",
                "policy_review_reminders", "regulatory_alerts",
            ],
            "key_metrics": [
                "audit_findings", "compliance_score", "time_to_remediation",
            ],
        },
        "it": {
            "processes": [
                "infrastructure_management", "security", "backup",
                "monitoring", "helpdesk", "deployment",
            ],
            "common_tools": [
                "AWS", "Azure", "Datadog", "PagerDuty", "Terraform",
            ],
            "automation_patterns": [
                "backup_scheduling", "alert_routing",
                "deployment_pipelines", "security_scanning",
            ],
            "key_metrics": [
                "uptime", "mean_time_to_recovery", "incident_count",
            ],
        },
    }

    BUSINESS_TYPES: dict[str, dict] = {
        "ecommerce": {
            "primary_domains": ["sales", "inventory", "finance", "customer_service"],
            "typical_pain_points": [
                "order_reconciliation", "inventory_sync", "manual_invoicing",
                "returns_processing", "shipping_label_generation",
            ],
            "high_value_automations": [
                "order_to_invoice", "inventory_alerts", "customer_notification",
                "returns_workflow", "shipping_integration",
            ],
        },
        "saas": {
            "primary_domains": ["sales", "customer_service", "it", "finance"],
            "typical_pain_points": [
                "churn_tracking", "usage_monitoring", "billing_reconciliation",
                "onboarding_flow",
            ],
            "high_value_automations": [
                "churn_prediction_alerts", "usage_reports",
                "auto_billing", "onboarding_sequences",
            ],
        },
        "manufacturing": {
            "primary_domains": ["operations", "inventory", "procurement", "compliance"],
            "typical_pain_points": [
                "production_scheduling", "quality_defects",
                "supplier_delays", "inventory_overstock",
            ],
            "high_value_automations": [
                "production_scheduling", "quality_alerts",
                "reorder_automation", "compliance_reports",
            ],
        },
        "professional_services": {
            "primary_domains": ["operations", "finance", "hr", "sales"],
            "typical_pain_points": [
                "time_tracking", "project_billing",
                "resource_allocation", "proposal_generation",
            ],
            "high_value_automations": [
                "timesheet_to_invoice", "utilization_reports",
                "proposal_templates", "project_status_updates",
            ],
        },
        "retail": {
            "primary_domains": ["sales", "inventory", "finance", "marketing"],
            "typical_pain_points": [
                "pos_reconciliation", "stock_replenishment",
                "seasonal_demand", "pricing_management", "shrinkage_tracking",
            ],
            "high_value_automations": [
                "pos_to_accounting", "low_stock_alerts",
                "demand_forecasting", "price_update_automation",
                "inventory_audit_reports",
            ],
        },
        "healthcare": {
            "primary_domains": ["compliance", "operations", "finance", "hr"],
            "typical_pain_points": [
                "patient_scheduling", "insurance_claims",
                "regulatory_compliance", "record_keeping", "staff_scheduling",
            ],
            "high_value_automations": [
                "appointment_reminders", "claims_processing",
                "compliance_audit_prep", "patient_intake_forms",
                "shift_scheduling",
            ],
        },
        "logistics": {
            "primary_domains": ["operations", "inventory", "procurement", "finance"],
            "typical_pain_points": [
                "route_optimization", "shipment_tracking",
                "warehouse_efficiency", "carrier_management",
                "delivery_confirmation",
            ],
            "high_value_automations": [
                "route_planning", "shipment_status_updates",
                "warehouse_pick_lists", "carrier_rate_comparison",
                "proof_of_delivery",
            ],
        },
        "construction": {
            "primary_domains": ["operations", "finance", "procurement", "compliance"],
            "typical_pain_points": [
                "project_cost_tracking", "subcontractor_management",
                "permit_tracking", "material_ordering", "change_orders",
            ],
            "high_value_automations": [
                "budget_vs_actual_reports", "subcontractor_invoicing",
                "permit_deadline_alerts", "material_reorder",
                "change_order_workflow",
            ],
        },
        "hospitality": {
            "primary_domains": ["operations", "customer_service", "finance", "hr"],
            "typical_pain_points": [
                "reservation_management", "staff_scheduling",
                "guest_feedback", "inventory_waste", "seasonal_pricing",
            ],
            "high_value_automations": [
                "booking_confirmation", "shift_auto_scheduling",
                "review_response", "food_cost_tracking",
                "dynamic_pricing",
            ],
        },
        "education": {
            "primary_domains": ["operations", "finance", "hr", "compliance"],
            "typical_pain_points": [
                "enrollment_processing", "grade_management",
                "faculty_scheduling", "accreditation_tracking",
                "tuition_billing",
            ],
            "high_value_automations": [
                "enrollment_workflow", "grade_distribution_reports",
                "class_scheduling", "accreditation_document_prep",
                "tuition_invoicing",
            ],
        },
        "fintech": {
            "primary_domains": ["finance", "compliance", "it", "customer_service"],
            "typical_pain_points": [
                "transaction_monitoring", "kyc_verification",
                "regulatory_reporting", "fraud_detection", "reconciliation",
            ],
            "high_value_automations": [
                "transaction_alerts", "kyc_document_collection",
                "regulatory_report_generation", "fraud_flagging",
                "auto_reconciliation",
            ],
        },
        "media": {
            "primary_domains": ["marketing", "operations", "sales", "finance"],
            "typical_pain_points": [
                "content_scheduling", "ad_revenue_tracking",
                "rights_management", "audience_analytics",
                "freelancer_payments",
            ],
            "high_value_automations": [
                "content_calendar_automation", "revenue_reporting",
                "license_expiry_alerts", "audience_segment_reports",
                "freelancer_invoicing",
            ],
        },
    }

    def map_company(self, company_model: "CompanyModel") -> OntologyMapping:
        """Map a CompanyModel onto the business ontology."""
        btype = company_model.business_type.lower().replace(" ", "_")
        type_info = self.BUSINESS_TYPES.get(btype, {})
        primary_domains = type_info.get("primary_domains", [])

        # Match software to domains
        active_tools: dict[str, list[str]] = {}
        software_matched_domains: set[str] = set()
        for sw in company_model.software_stack:
            sw_name = sw.get("name", "")
            for domain_name, domain_data in self.DOMAINS.items():
                for tool in domain_data["common_tools"]:
                    if sw_name.lower() == tool.lower():
                        software_matched_domains.add(domain_name)
                        active_tools.setdefault(domain_name, []).append(sw_name)

        # Match processes to domains
        confirmed_processes: list[dict] = []
        process_matched_domains: set[str] = set()
        for proc in company_model.detected_processes:
            proc_name = proc.get("name", "").lower().replace(" ", "_")
            for domain_name, domain_data in self.DOMAINS.items():
                if proc_name in domain_data["processes"]:
                    process_matched_domains.add(domain_name)
                    confirmed_processes.append({
                        "process": proc_name,
                        "domain": domain_name,
                        "manual": proc.get("manual", False),
                        "frequency": proc.get("frequency", "unknown"),
                    })

        # Union all matched domains
        all_matched = set(primary_domains) | software_matched_domains | process_matched_domains

        # Identify gaps: primary domains with no tools and no confirmed processes
        gaps: list[dict] = []
        for domain in primary_domains:
            if domain not in software_matched_domains and domain not in process_matched_domains:
                gaps.append({
                    "domain": domain,
                    "reason": "Expected for this business type but no tools or processes detected",
                })

        # Build suggested automations from matched domains
        suggested: list[dict] = []
        for domain_name in all_matched:
            domain_data = self.DOMAINS.get(domain_name, {})
            for pattern in domain_data.get("automation_patterns", []):
                suggested.append({
                    "name": pattern,
                    "domain": domain_name,
                    "description": f"Automation pattern for {domain_name}: {pattern}",
                    "priority": "low",
                    "evidence": "domain match",
                })

        return OntologyMapping(
            business_type=btype,
            matched_domains=sorted(all_matched),
            active_tools_by_domain=active_tools,
            confirmed_processes=confirmed_processes,
            suggested_automations=suggested,
            identified_gaps=gaps,
        )

    def suggest_automations(self, mapping: OntologyMapping) -> list[dict]:
        """Suggest prioritized automations for this company."""
        type_info = self.BUSINESS_TYPES.get(mapping.business_type, {})
        high_value = type_info.get("high_value_automations", [])
        confirmed_names = {p["process"] for p in mapping.confirmed_processes}
        gap_domains = {g["domain"] for g in mapping.identified_gaps}

        seen: set[str] = set()
        suggestions: list[dict] = []

        # High priority: high-value automations where a confirmed process exists
        for auto in high_value:
            if auto not in seen:
                seen.add(auto)
                has_process = any(auto.replace("_", " ") in p or p in auto for p in confirmed_names)
                suggestions.append({
                    "name": auto,
                    "domain": mapping.business_type,
                    "description": f"High-value automation: {auto}",
                    "priority": "high" if has_process else "medium",
                    "evidence": "confirmed process" if has_process else "business type match",
                })

        # Domain automation patterns
        for domain_name in mapping.matched_domains:
            domain_data = self.DOMAINS.get(domain_name, {})
            for pattern in domain_data.get("automation_patterns", []):
                if pattern not in seen:
                    seen.add(pattern)
                    if domain_name in gap_domains:
                        priority = "medium"
                        evidence = "identified gap"
                    else:
                        priority = "low"
                        evidence = "domain match"
                    suggestions.append({
                        "name": pattern,
                        "domain": domain_name,
                        "description": f"Automation for {domain_name}: {pattern}",
                        "priority": priority,
                        "evidence": evidence,
                    })

        # Sort: high > medium > low
        priority_order = {"high": 0, "medium": 1, "low": 2}
        suggestions.sort(key=lambda s: priority_order.get(s["priority"], 3))
        return suggestions

    def get_context_for_agent(self, agent_name: str, mapping: OntologyMapping) -> str:
        """Generate concise context string with only relevant domain info."""
        parts: list[str] = [
            f"Business type: {mapping.business_type}",
            f"Active domains: {', '.join(mapping.matched_domains)}",
        ]

        for domain_name in mapping.matched_domains:
            domain_data = self.DOMAINS.get(domain_name)
            if domain_data:
                tools = mapping.active_tools_by_domain.get(domain_name, [])
                procs = [p["process"] for p in mapping.confirmed_processes if p["domain"] == domain_name]
                parts.append(
                    f"\n[{domain_name}]\n"
                    f"  Processes: {', '.join(domain_data['processes'][:5])}\n"
                    f"  Active tools: {', '.join(tools) if tools else 'none detected'}\n"
                    f"  Confirmed processes: {', '.join(procs) if procs else 'none confirmed'}\n"
                    f"  Automation patterns: {', '.join(domain_data['automation_patterns'][:3])}"
                )

        if mapping.identified_gaps:
            gap_names = [g["domain"] for g in mapping.identified_gaps]
            parts.append(f"\nIdentified gaps: {', '.join(gap_names)}")

        return "\n".join(parts)
