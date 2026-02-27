"""Supabase connection layer covering all 14 table groups."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from supabase import Client, create_client

logger = logging.getLogger(__name__)


class SupabaseManager:
    """Manages all Supabase table operations with graceful error handling."""

    def __init__(
        self,
        supabase_url: str,
        supabase_key: str,
        company_id: str,
    ) -> None:
        self._client: Client = create_client(supabase_url, supabase_key)
        self._company_id = company_id

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _safe_execute(self, fn: Any) -> Any:
        """Execute a callable, returning None on any failure."""
        try:
            result = fn()
            return result.data if hasattr(result, "data") else result
        except Exception as exc:
            logger.warning("Supabase operation failed: %s", exc)
            return None

    def _safe_query(self, fn: Any) -> list:
        """Execute a query callable, returning [] on any failure."""
        try:
            result = fn()
            data = result.data if hasattr(result, "data") else result
            return data if isinstance(data, list) else []
        except Exception as exc:
            logger.warning("Supabase query failed: %s", exc)
            return []

    # ------------------------------------------------------------------
    # 1. Companies
    # ------------------------------------------------------------------

    def register_company(self, name: str, agent_name: str) -> str | None:
        data = self._safe_execute(
            lambda: self._client.table("companies")
            .insert({"name": name, "agent_name": agent_name, "created_at": self._now()})
            .execute()
        )
        if data and isinstance(data, list) and len(data) > 0:
            return data[0].get("id")
        return None

    def update_company(self, company_id: str, fields: dict) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("companies")
            .update({**fields, "updated_at": self._now()})
            .eq("id", company_id)
            .execute()
        )

    def get_company(self, company_id: str) -> dict | None:
        data = self._safe_query(
            lambda: self._client.table("companies")
            .select("*")
            .eq("id", company_id)
            .execute()
        )
        return data[0] if data else None

    # ------------------------------------------------------------------
    # 2. Agent statuses
    # ------------------------------------------------------------------

    def update_agent_status(
        self,
        company_id: str,
        agent_name: str,
        status: str,
        task: str,
        detail: str | None = None,
    ) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("agent_statuses")
            .upsert({
                "company_id": company_id,
                "agent_name": agent_name,
                "status": status,
                "current_task": task,
                "error_message": detail,
                "updated_at": self._now(),
            })
            .execute()
        )

    def get_agent_statuses(self, company_id: str) -> list:
        return self._safe_query(
            lambda: self._client.table("agent_statuses")
            .select("*")
            .eq("company_id", company_id)
            .execute()
        )

    # ------------------------------------------------------------------
    # 3. Automations
    # ------------------------------------------------------------------

    def upsert_automation(self, company_id: str, data: dict) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("automations")
            .upsert({**data, "company_id": company_id, "updated_at": self._now()})
            .execute()
        )

    def update_automation_status(
        self,
        automation_id: str,
        status: str,
        shadow_report: dict | None = None,
    ) -> dict | None:
        fields: dict = {"status": status, "updated_at": self._now()}
        if shadow_report is not None:
            fields["shadow_result"] = shadow_report
        return self._safe_execute(
            lambda: self._client.table("automations")
            .update(fields)
            .eq("id", automation_id)
            .execute()
        )

    def get_automations(self, company_id: str) -> list:
        return self._safe_query(
            lambda: self._client.table("automations")
            .select("*")
            .eq("company_id", company_id)
            .execute()
        )

    # ------------------------------------------------------------------
    # 4. Events
    # ------------------------------------------------------------------

    def log_event(
        self,
        company_id: str,
        event_type: str,
        agent_name: str,
        message: str,
        severity: str = "info",
        metadata: dict | None = None,
    ) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("events")
            .insert({
                "company_id": company_id,
                "event_type": event_type,
                "agent_name": agent_name,
                "message": message,
                "severity": severity,
                "metadata": metadata,
                "created_at": self._now(),
            })
            .execute()
        )

    def get_events(
        self,
        company_id: str,
        limit: int = 50,
        agent_name: str | None = None,
        severity: str | None = None,
    ) -> list:
        def _query():
            q = (
                self._client.table("events")
                .select("*")
                .eq("company_id", company_id)
            )
            if agent_name:
                q = q.eq("agent_name", agent_name)
            if severity:
                q = q.eq("severity", severity)
            return q.order("created_at", desc=True).limit(limit).execute()

        return self._safe_query(_query)

    # ------------------------------------------------------------------
    # 5. Messages (the chat system)
    # ------------------------------------------------------------------

    def send_message(
        self,
        company_id: str,
        agent_name: str,
        content: str,
        message_type: str = "chat",
        metadata: dict | None = None,
    ) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("messages")
            .insert({
                "company_id": company_id,
                "sender": agent_name,
                "content": content,
                "message_type": message_type,
                "metadata": metadata,
                "created_at": self._now(),
            })
            .execute()
        )

    def get_new_messages(self, company_id: str, since_timestamp: str) -> list:
        return self._safe_query(
            lambda: self._client.table("messages")
            .select("*")
            .eq("company_id", company_id)
            .gt("created_at", since_timestamp)
            .order("created_at", desc=False)
            .execute()
        )

    def get_chat_history(
        self,
        company_id: str,
        agent_name: str,
        limit: int = 50,
    ) -> list:
        return self._safe_query(
            lambda: self._client.table("messages")
            .select("*")
            .eq("company_id", company_id)
            .eq("sender", agent_name)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )

    # ------------------------------------------------------------------
    # 6. Knowledge
    # ------------------------------------------------------------------

    def add_knowledge(
        self,
        company_id: str,
        category: str,
        key: str,
        value: str,
        source: str,
        confidence: float = 0.8,
    ) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("knowledge")
            .insert({
                "company_id": company_id,
                "category": category,
                "key": key,
                "value": value,
                "source": source,
                "confidence": confidence,
                "created_at": self._now(),
            })
            .execute()
        )

    def query_knowledge(
        self,
        company_id: str,
        category: str | None = None,
        search: str | None = None,
    ) -> list:
        def _query():
            q = (
                self._client.table("knowledge")
                .select("*")
                .eq("company_id", company_id)
            )
            if category:
                q = q.eq("category", category)
            if search:
                q = q.ilike("value", f"%{search}%")
            return q.order("created_at", desc=True).execute()

        return self._safe_query(_query)

    # ------------------------------------------------------------------
    # 7. Decisions
    # ------------------------------------------------------------------

    def create_decision(
        self,
        company_id: str,
        agent_name: str,
        question: str,
        option_a: str,
        option_b: str,
        context: str,
        risk_level: str = "low",
    ) -> str | None:
        data = self._safe_execute(
            lambda: self._client.table("decisions")
            .insert({
                "company_id": company_id,
                "agent_name": agent_name,
                "question": question,
                "option_a": option_a,
                "option_b": option_b,
                "context": context,
                "risk_level": risk_level,
                "status": "pending",
                "created_at": self._now(),
            })
            .execute()
        )
        if data and isinstance(data, list) and len(data) > 0:
            return data[0].get("id")
        return None

    def resolve_decision(
        self,
        decision_id: str,
        chosen_option: str,
        note: str | None = None,
    ) -> dict | None:
        fields: dict = {
            "chosen_option": chosen_option,
            "status": "resolved",
            "resolved_at": self._now(),
        }
        if note:
            fields["note"] = note
        return self._safe_execute(
            lambda: self._client.table("decisions")
            .update(fields)
            .eq("id", decision_id)
            .execute()
        )

    def poll_decision(self, decision_id: str) -> dict | None:
        data = self._safe_query(
            lambda: self._client.table("decisions")
            .select("*")
            .eq("id", decision_id)
            .execute()
        )
        return data[0] if data else None

    def get_pending_decisions(self, company_id: str) -> list:
        return self._safe_query(
            lambda: self._client.table("decisions")
            .select("*")
            .eq("company_id", company_id)
            .eq("status", "pending")
            .order("created_at", desc=True)
            .execute()
        )

    # ------------------------------------------------------------------
    # 8. Playbooks
    # ------------------------------------------------------------------

    def add_playbook_entry(
        self,
        company_id: str,
        agent_name: str,
        entry: dict,
    ) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("playbook_entries")
            .insert({
                **entry,
                "company_id": company_id,
                "agent_name": agent_name,
                "created_at": self._now(),
            })
            .execute()
        )

    def query_playbook(
        self,
        company_id: str,
        agent_name: str,
        tags: list,
        limit: int = 5,
    ) -> list:
        return self._safe_query(
            lambda: self._client.table("playbook_entries")
            .select("*")
            .eq("company_id", company_id)
            .eq("agent_name", agent_name)
            .contains("similarity_tags", tags)
            .limit(limit)
            .execute()
        )

    # ------------------------------------------------------------------
    # 9. Corrections
    # ------------------------------------------------------------------

    def log_correction(self, company_id: str, data: dict) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("corrections")
            .insert({
                **data,
                "company_id": company_id,
                "applied": False,
                "created_at": self._now(),
            })
            .execute()
        )

    def get_unapplied_corrections(self, company_id: str) -> list:
        return self._safe_query(
            lambda: self._client.table("corrections")
            .select("*")
            .eq("company_id", company_id)
            .eq("applied", False)
            .order("created_at", desc=True)
            .execute()
        )

    def mark_correction_applied(self, correction_id: str) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("corrections")
            .update({"applied": True, "applied_at": self._now()})
            .eq("id", correction_id)
            .execute()
        )

    # ------------------------------------------------------------------
    # 10. Research
    # ------------------------------------------------------------------

    def add_research_source(self, company_id: str, data: dict) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("research_sources")
            .insert({**data, "company_id": company_id, "created_at": self._now()})
            .execute()
        )

    def add_research_insight(self, company_id: str, data: dict) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("research_insights")
            .insert({**data, "company_id": company_id, "created_at": self._now()})
            .execute()
        )

    def get_research_library(self, company_id: str) -> list:
        return self._safe_query(
            lambda: self._client.table("research_sources")
            .select("*")
            .eq("company_id", company_id)
            .order("created_at", desc=True)
            .execute()
        )

    # ------------------------------------------------------------------
    # 11. Brain states
    # ------------------------------------------------------------------

    def save_brain_state(self, company_id: str, data: dict) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("brain_states")
            .insert({"state": data, "company_id": company_id, "created_at": self._now()})
            .execute()
        )

    def get_latest_brain_state(self, company_id: str) -> dict | None:
        data = self._safe_query(
            lambda: self._client.table("brain_states")
            .select("*")
            .eq("company_id", company_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if not data:
            return None
        row = data[0]
        return row.get("state") if isinstance(row.get("state"), dict) else None

    # ------------------------------------------------------------------
    # 12. Ghost reports
    # ------------------------------------------------------------------

    def save_ghost_report(self, company_id: str, data: dict) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("ghost_reports")
            .insert({**data, "company_id": company_id, "created_at": self._now()})
            .execute()
        )

    def get_ghost_reports(self, company_id: str) -> list:
        return self._safe_query(
            lambda: self._client.table("ghost_reports")
            .select("*")
            .eq("company_id", company_id)
            .order("created_at", desc=True)
            .execute()
        )

    # ------------------------------------------------------------------
    # 13. Metrics
    # ------------------------------------------------------------------

    def increment_metric(
        self,
        company_id: str,
        field: str,
        amount: int = 1,
    ) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("metrics")
            .upsert({
                "company_id": company_id,
                "metric_name": field,
                "metric_value": amount,
                "created_at": self._now(),
            })
            .execute()
        )

    def get_metrics(
        self,
        company_id: str,
        start_date: str,
        end_date: str,
    ) -> list:
        return self._safe_query(
            lambda: self._client.table("metrics")
            .select("*")
            .eq("company_id", company_id)
            .gte("created_at", start_date)
            .lte("created_at", end_date)
            .order("created_at", desc=True)
            .execute()
        )

    # ------------------------------------------------------------------
    # 14. Cross-company patterns
    # ------------------------------------------------------------------

    def add_pattern(self, data: dict) -> dict | None:
        return self._safe_execute(
            lambda: self._client.table("cross_company_patterns")
            .insert({**data, "created_at": self._now()})
            .execute()
        )

    def query_patterns(
        self,
        industry: str | None = None,
        business_type: str | None = None,
        tools: list | None = None,
    ) -> list:
        def _query():
            q = self._client.table("cross_company_patterns").select("*")
            if industry:
                q = q.eq("industry", industry)
            if business_type:
                q = q.eq("business_type", business_type)
            if tools:
                q = q.contains("tools", tools)
            return q.order("created_at", desc=True).execute()

        return self._safe_query(_query)
