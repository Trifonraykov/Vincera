"""Analyst Agent — evaluates performance and identifies optimization opportunities."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from pydantic import BaseModel

from vincera.agents.base import BaseAgent

if TYPE_CHECKING:
    from vincera.config import VinceraSettings
    from vincera.core.llm import OpenRouterClient
    from vincera.core.priority import PriorityEngine
    from vincera.core.state import GlobalState
    from vincera.execution.monitor import DeploymentMonitor
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.verification.verifier import Verifier

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class AnalysisReport(BaseModel):
    report_type: str  # "performance", "optimization", "trend"
    summary: str
    findings: list[dict] = []
    metrics: dict = {}
    generated_at: str


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

class AnalystAgent(BaseAgent):
    """Analyzes automation performance, identifies patterns, recommends optimizations."""

    def __init__(
        self,
        name: str,
        company_id: str,
        config: VinceraSettings,
        llm: OpenRouterClient,
        supabase: SupabaseManager,
        state: GlobalState,
        verifier: Verifier,
        monitor: DeploymentMonitor,
        priority_engine: PriorityEngine,
    ) -> None:
        super().__init__(name, company_id, config, llm, supabase, state, verifier)
        self._monitor = monitor
        self._priority_engine = priority_engine

    # ------------------------------------------------------------------
    # Main dispatch
    # ------------------------------------------------------------------

    async def run(self, task: dict) -> dict:
        task_type = task.get("type", "")

        if task_type == "performance_review":
            return await self._performance_review(task)
        elif task_type == "optimization_scan":
            return await self._optimization_scan(task)
        elif task_type == "trend_analysis":
            return await self._trend_analysis(task)
        else:
            return {"status": "error", "reason": f"Unknown task type: {task_type}"}

    # ------------------------------------------------------------------
    # Performance review
    # ------------------------------------------------------------------

    async def _performance_review(self, task: dict) -> dict:
        deployment_ids = task.get("deployment_ids", [])

        if not deployment_ids:
            await self.send_message("No deployments to analyze yet.", message_type="chat")
            return {"status": "complete", "findings": [], "deployments_analyzed": 0}

        reports = []
        for dep_id in deployment_ids:
            report = await self._monitor.assess_health(dep_id)
            reports.append(report)

        findings: list[dict] = []
        for report in reports:
            error_rate = report.metrics.get("error_rate", 0)
            avg_latency = report.metrics.get("avg_latency", 0)

            if error_rate > 0.1:
                findings.append({
                    "finding": f"Deployment '{report.deployment_id}' has {error_rate:.1%} error rate",
                    "severity": "high" if error_rate > 0.3 else "medium",
                    "recommendation": (
                        "Investigate errors and consider rollback"
                        if error_rate > 0.3
                        else "Monitor closely"
                    ),
                })

            if avg_latency > 30:
                findings.append({
                    "finding": f"Deployment '{report.deployment_id}' averaging {avg_latency:.1f}s execution time",
                    "severity": "medium",
                    "recommendation": "Optimize for performance",
                })

        # LLM deeper analysis
        if reports:
            health_summary = "\n".join(
                f"- {r.deployment_id}: {r.status.value}, metrics={r.metrics}"
                for r in reports
            )
            llm_analysis = await self._llm.think_structured(
                "You are an automation deployment analyst.",
                f"Analyze these automation deployment metrics and identify patterns:\n{health_summary}\n\n"
                "Provide findings with severity (low/medium/high) and recommendations.",
                {
                    "type": "object",
                    "properties": {
                        "findings": {"type": "array", "items": {
                            "type": "object",
                            "properties": {
                                "finding": {"type": "string"},
                                "severity": {"type": "string"},
                                "recommendation": {"type": "string"},
                            },
                        }},
                    },
                },
            )
            if isinstance(llm_analysis, dict):
                findings.extend(llm_analysis.get("findings", []))

        # Narrate
        if findings:
            narration = f"Performance review of {len(reports)} deployments:\n"
            for i, f in enumerate(findings[:5], 1):
                narration += f"{i}. [{f.get('severity', 'info')}] {f['finding']}\n"
            await self.send_message(narration, message_type="chat")
        else:
            await self.send_message(
                f"All {len(reports)} deployments running healthy. No issues found.",
                message_type="chat",
            )

        return {
            "status": "complete",
            "deployments_analyzed": len(reports),
            "findings_count": len(findings),
            "findings": findings,
        }

    # ------------------------------------------------------------------
    # Optimization scan
    # ------------------------------------------------------------------

    async def _optimization_scan(self, task: dict) -> dict:
        company_model_data = task.get("company_model", {})

        result = await self._llm.think_structured(
            "You are a business process optimization analyst.",
            f"Given this business context:\n{str(company_model_data)[:2000]}\n\n"
            "Identify 3-5 new optimization opportunities.",
            {
                "type": "object",
                "properties": {
                    "opportunities": {"type": "array", "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "description": {"type": "string"},
                            "estimated_impact": {"type": "string"},
                            "complexity": {"type": "string"},
                        },
                    }},
                },
            },
        )

        opportunities = result.get("opportunities", []) if isinstance(result, dict) else []

        if opportunities:
            narration = f"Found {len(opportunities)} optimization opportunities:\n"
            for i, opp in enumerate(opportunities[:5], 1):
                narration += f"{i}. {opp.get('name', 'Unknown')}: {opp.get('description', '')[:100]}\n"
            await self.send_message(narration, message_type="chat")

        return {"status": "complete", "opportunities": opportunities}

    # ------------------------------------------------------------------
    # Trend analysis
    # ------------------------------------------------------------------

    async def _trend_analysis(self, task: dict) -> dict:
        deployment_id = task.get("deployment_id", "")
        logs = self._monitor.get_execution_logs(deployment_id)

        if not logs:
            return {"status": "error", "reason": "No monitoring data for this deployment"}

        report = await self._monitor.assess_health(deployment_id)
        error_rate = report.metrics.get("error_rate", 0)
        avg_latency = report.metrics.get("avg_latency", 0)

        trend = (
            "stable" if error_rate < 0.05
            else "degrading" if error_rate < 0.2
            else "critical"
        )

        await self.send_message(
            f"Trend analysis for '{deployment_id}': {trend}. "
            f"Error rate: {error_rate:.1%}, Avg latency: {avg_latency:.1f}s over {len(logs)} runs.",
            message_type="chat",
        )

        return {
            "status": "complete",
            "deployment_id": deployment_id,
            "current_status": report.status.value,
            "error_rate": error_rate,
            "avg_execution_time": avg_latency,
            "total_runs": len(logs),
            "trend": trend,
        }
