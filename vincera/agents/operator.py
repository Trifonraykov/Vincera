"""Operator Agent — manages running automations, health, and canary deployments."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from vincera.agents.base import BaseAgent

if TYPE_CHECKING:
    from vincera.config import VinceraSettings
    from vincera.core.llm import OpenRouterClient
    from vincera.core.state import GlobalState
    from vincera.execution.canary import CanaryExecutor
    from vincera.execution.deployment_pipeline import DeploymentPipeline
    from vincera.execution.monitor import DeploymentMonitor
    from vincera.execution.sandbox import DockerSandbox
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.verification.verifier import Verifier

logger = logging.getLogger(__name__)


class OperatorAgent(BaseAgent):
    """Executes scheduled automation runs, monitors health, handles canary deployments."""

    def __init__(
        self,
        name: str,
        company_id: str,
        config: VinceraSettings,
        llm: OpenRouterClient,
        supabase: SupabaseManager,
        state: GlobalState,
        verifier: Verifier,
        sandbox: DockerSandbox,
        monitor: DeploymentMonitor,
        canary: CanaryExecutor,
        pipeline: DeploymentPipeline,
    ) -> None:
        super().__init__(name, company_id, config, llm, supabase, state, verifier)
        self._sandbox = sandbox
        self._monitor = monitor
        self._canary = canary
        self._pipeline = pipeline

    # ------------------------------------------------------------------
    # Main dispatch
    # ------------------------------------------------------------------

    async def run(self, task: dict) -> dict:
        task_type = task.get("type", "")

        if task_type == "execute_automation":
            return await self._execute_automation(task)
        elif task_type == "run_canary":
            return await self._run_canary(task)
        elif task_type == "health_check":
            return await self._health_check(task)
        elif task_type == "run_batch":
            return await self._run_batch(task)
        else:
            return {"status": "error", "reason": f"Unknown task type: {task_type}"}

    # ------------------------------------------------------------------
    # Execute automation
    # ------------------------------------------------------------------

    async def _execute_automation(self, task: dict) -> dict:
        deployment_id = task["deployment_id"]
        script = task["script"]
        name = task.get("automation_name", "unknown")

        await self.send_message(f"Running automation: {name}", message_type="chat")

        result = await self._sandbox.execute_python(script, timeout=60)

        self._monitor.add_execution_log(
            deployment_id,
            success=result.success,
            execution_time_seconds=result.execution_time_seconds,
        )

        if result.success:
            await self.log_action("execute", name, "success", result.stdout[:500])
            await self.send_message(
                f"{name} completed in {result.execution_time_seconds:.1f}s",
                message_type="chat",
            )
        else:
            await self.log_action("execute", name, "failed", result.stderr[:500])
            await self.send_message(
                f"{name} failed: {result.stderr[:200]}",
                message_type="chat",
            )

        return {
            "status": "success" if result.success else "failed",
            "execution_time": result.execution_time_seconds,
            "output": result.stdout[:500] if result.success else result.stderr[:500],
        }

    # ------------------------------------------------------------------
    # Run canary
    # ------------------------------------------------------------------

    async def _run_canary(self, task: dict) -> dict:
        deployment_id = task["deployment_id"]
        script = task["script"]

        state = await self._canary.start_canary(deployment_id, script)

        await self.send_message(
            f"Started canary deployment for '{task.get('automation_name', 'unknown')}' ({deployment_id})",
            message_type="chat",
        )

        result = await self._sandbox.execute_python(script, timeout=60)
        await self._canary.record_execution(deployment_id, result.success)

        status = await self._canary.evaluate(deployment_id)

        return {
            "status": status.value,
            "deployment_id": deployment_id,
            "execution_success": result.success,
        }

    # ------------------------------------------------------------------
    # Health check
    # ------------------------------------------------------------------

    async def _health_check(self, task: dict) -> dict:
        deployment_ids = task.get("deployment_ids", [])
        results = {}

        for dep_id in deployment_ids:
            report = await self._monitor.assess_health(dep_id)
            needs_rollback = await self._monitor.should_rollback(dep_id)
            results[dep_id] = {
                "status": report.status.value,
                "metrics": report.metrics,
                "breached_rules": report.breached_rules,
                "needs_rollback": needs_rollback,
            }

        unhealthy = [
            k for k, v in results.items()
            if v.get("status") in ("failing", "degraded")
        ]
        if unhealthy:
            await self.send_message(
                f"Health check: {len(unhealthy)} deployment(s) need attention: {', '.join(unhealthy)}",
                message_type="chat",
            )

        return {
            "status": "complete",
            "deployments": results,
            "unhealthy_count": len(unhealthy),
        }

    # ------------------------------------------------------------------
    # Run batch
    # ------------------------------------------------------------------

    async def _run_batch(self, task: dict) -> dict:
        automations = task.get("automations", [])
        results = []

        for auto in automations:
            result = await self._execute_automation(auto)
            results.append({"name": auto.get("automation_name", "unknown"), **result})

        successes = sum(1 for r in results if r["status"] == "success")
        await self.send_message(
            f"Batch complete: {successes}/{len(results)} automations succeeded.",
            message_type="chat",
        )

        return {
            "status": "complete",
            "total": len(results),
            "successes": successes,
            "results": results,
        }
