"""Deployment Monitor — rule-based health monitoring for deployments."""

from __future__ import annotations

import logging
import time
from enum import Enum
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.knowledge.supabase_client import SupabaseManager

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class HealthStatus(str, Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    FAILING = "failing"
    UNKNOWN = "unknown"


# Severity ordering for picking worst status
_STATUS_SEVERITY: dict[HealthStatus, int] = {
    HealthStatus.UNKNOWN: 0,
    HealthStatus.HEALTHY: 1,
    HealthStatus.DEGRADED: 2,
    HealthStatus.FAILING: 3,
}


class HealthRule(BaseModel):
    """A single health-check rule."""

    name: str
    metric: str  # "error_rate" or "avg_latency"
    threshold: float
    window_seconds: int = 300
    status_on_breach: HealthStatus


class HealthReport(BaseModel):
    """Result of a health assessment."""

    deployment_id: str
    status: HealthStatus
    breached_rules: list[str]
    metrics: dict
    checked_at: str


# ---------------------------------------------------------------------------
# Monitor
# ---------------------------------------------------------------------------

class DeploymentMonitor:
    """Watches deployment health via rule-based monitoring."""

    def __init__(
        self,
        supabase: SupabaseManager,
        company_id: str,
    ) -> None:
        self._sb = supabase
        self._company_id = company_id
        self._execution_logs: dict[str, list[dict]] = {}
        self._rules: list[HealthRule] = self.default_rules()

    # ------------------------------------------------------------------
    # Default rules
    # ------------------------------------------------------------------

    @staticmethod
    def default_rules() -> list[HealthRule]:
        return [
            HealthRule(
                name="error_rate_degraded",
                metric="error_rate",
                threshold=0.10,
                window_seconds=300,
                status_on_breach=HealthStatus.DEGRADED,
            ),
            HealthRule(
                name="error_rate_failing",
                metric="error_rate",
                threshold=0.30,
                window_seconds=300,
                status_on_breach=HealthStatus.FAILING,
            ),
            HealthRule(
                name="latency_degraded",
                metric="avg_latency",
                threshold=5.0,
                window_seconds=300,
                status_on_breach=HealthStatus.DEGRADED,
            ),
        ]

    # ------------------------------------------------------------------
    # Execution logging
    # ------------------------------------------------------------------

    def add_execution_log(
        self,
        deployment_id: str,
        success: bool,
        execution_time_seconds: float,
        metadata: dict | None = None,
    ) -> None:
        if deployment_id not in self._execution_logs:
            self._execution_logs[deployment_id] = []

        self._execution_logs[deployment_id].append({
            "success": success,
            "execution_time_seconds": execution_time_seconds,
            "metadata": metadata or {},
            "timestamp": time.monotonic(),
        })

    def get_execution_logs(self, deployment_id: str) -> list[dict]:
        return self._execution_logs.get(deployment_id, [])

    # ------------------------------------------------------------------
    # Health assessment
    # ------------------------------------------------------------------

    async def assess_health(self, deployment_id: str) -> HealthReport:
        from datetime import datetime, timezone

        logs = self._execution_logs.get(deployment_id, [])
        now_mono = time.monotonic()
        checked_at = datetime.now(timezone.utc).isoformat()

        if not logs:
            return HealthReport(
                deployment_id=deployment_id,
                status=HealthStatus.UNKNOWN,
                breached_rules=[],
                metrics={},
                checked_at=checked_at,
            )

        breached: list[str] = []
        worst_status = HealthStatus.HEALTHY
        metrics: dict = {}

        for rule in self._rules:
            # Filter logs within the rule's time window
            window_logs = [
                lg for lg in logs
                if (now_mono - lg["timestamp"]) <= rule.window_seconds
            ]
            if not window_logs:
                continue

            # Compute metric
            if rule.metric == "error_rate":
                failures = sum(1 for lg in window_logs if not lg["success"])
                value = failures / len(window_logs)
                metrics["error_rate"] = round(value, 4)
            elif rule.metric == "avg_latency":
                value = sum(lg["execution_time_seconds"] for lg in window_logs) / len(window_logs)
                metrics["avg_latency"] = round(value, 4)
            else:
                continue

            if value > rule.threshold:
                breached.append(rule.name)
                if _STATUS_SEVERITY[rule.status_on_breach] > _STATUS_SEVERITY[worst_status]:
                    worst_status = rule.status_on_breach

        return HealthReport(
            deployment_id=deployment_id,
            status=worst_status,
            breached_rules=breached,
            metrics=metrics,
            checked_at=checked_at,
        )

    # ------------------------------------------------------------------
    # Rollback decision
    # ------------------------------------------------------------------

    async def should_rollback(self, deployment_id: str) -> bool:
        report = await self.assess_health(deployment_id)
        return report.status == HealthStatus.FAILING
