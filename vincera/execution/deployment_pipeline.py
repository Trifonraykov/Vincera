"""Deployment Pipeline — sandbox → shadow → canary → full deployment."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.agents.base import BaseAgent
    from vincera.core.authority import AuthorityManager
    from vincera.execution.sandbox import DockerSandbox
    from vincera.execution.shadow import ShadowExecutor
    from vincera.knowledge.supabase_client import SupabaseManager

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class DeploymentStage(str, Enum):
    SANDBOX = "sandbox"
    SHADOW = "shadow"
    CANARY = "canary"
    FULL = "full"
    ROLLED_BACK = "rolled_back"


class DeploymentRecord(BaseModel):
    deployment_id: str
    automation_name: str
    script: str
    current_stage: DeploymentStage
    sandbox_result: dict | None = None
    shadow_result: dict | None = None
    canary_result: dict | None = None
    full_result: dict | None = None
    created_at: str
    updated_at: str
    promoted_by: str = "system"


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

class DeploymentPipeline:
    """Manages the full deployment lifecycle for automations."""

    def __init__(
        self,
        sandbox: DockerSandbox,
        shadow: ShadowExecutor,
        supabase: SupabaseManager,
        authority: AuthorityManager,
        company_id: str,
    ) -> None:
        self._sandbox = sandbox
        self._shadow = shadow
        self._sb = supabase
        self._authority = authority
        self._company_id = company_id
        self._deployments: dict[str, DeploymentRecord] = {}

    # ------------------------------------------------------------------
    # Start
    # ------------------------------------------------------------------

    async def start_deployment(
        self,
        automation_name: str,
        script: str,
        expected_behavior: str,
    ) -> DeploymentRecord:
        deployment_id = str(uuid.uuid4())[:12]
        now = datetime.now(timezone.utc).isoformat()

        record = DeploymentRecord(
            deployment_id=deployment_id,
            automation_name=automation_name,
            script=script,
            current_stage=DeploymentStage.SANDBOX,
            created_at=now,
            updated_at=now,
        )
        self._deployments[deployment_id] = record

        self._sb.upsert_automation(self._company_id, {
            "name": automation_name,
            "status": "sandbox",
            "deployment_id": deployment_id,
            "script": script[:1000],
        })

        return record

    # ------------------------------------------------------------------
    # Stage execution
    # ------------------------------------------------------------------

    async def run_sandbox_stage(self, deployment_id: str):
        from vincera.execution.sandbox import SandboxResult

        record = self._deployments[deployment_id]
        result = await self._sandbox.execute_python(record.script, timeout=30)
        record.sandbox_result = result.model_dump()
        record.updated_at = datetime.now(timezone.utc).isoformat()
        return result

    async def run_shadow_stage(self, deployment_id: str, expected_behavior: str):
        from vincera.execution.shadow import ShadowResult

        record = self._deployments[deployment_id]
        result = await self._shadow.run_shadow(
            record.automation_name, record.script, expected_behavior,
        )
        record.shadow_result = result.model_dump()
        record.updated_at = datetime.now(timezone.utc).isoformat()
        return result

    # ------------------------------------------------------------------
    # Promotion
    # ------------------------------------------------------------------

    async def promote(
        self,
        deployment_id: str,
        agent: BaseAgent | None = None,
    ) -> tuple[bool, str]:
        record = self._deployments[deployment_id]

        transitions = {
            DeploymentStage.SANDBOX: DeploymentStage.SHADOW,
            DeploymentStage.SHADOW: DeploymentStage.CANARY,
            DeploymentStage.CANARY: DeploymentStage.FULL,
        }

        next_stage = transitions.get(record.current_stage)
        if not next_stage:
            return (False, f"Cannot promote from {record.current_stage.value}")

        # Check previous stage passed
        if record.current_stage == DeploymentStage.SANDBOX:
            if not record.sandbox_result or not record.sandbox_result.get("success"):
                return (False, "Sandbox stage did not pass")

        elif record.current_stage == DeploymentStage.SHADOW:
            if not record.shadow_result:
                return (False, "Shadow stage not run yet")
            rec = record.shadow_result.get("recommendation")
            if rec not in ("promote", "retry"):
                return (False, f"Shadow recommendation: {rec}")

        # Authority check for CANARY and FULL
        if next_stage in (DeploymentStage.CANARY, DeploymentStage.FULL):
            risk = self._authority.classify_risk(
                f"Deploy {record.automation_name} to {next_stage.value}",
                modifies_system=True,
                is_reversible=(next_stage == DeploymentStage.CANARY),
            )
            if agent:
                approved = await self._authority.request_if_needed(
                    agent,
                    f"Deploy {record.automation_name} to {next_stage.value}",
                    risk,
                )
                if not approved:
                    return (False, "Deployment denied by authority check")

        record.current_stage = next_stage
        record.updated_at = datetime.now(timezone.utc).isoformat()

        self._sb.update_automation_status(
            deployment_id, next_stage.value,
        )

        return (True, next_stage.value)

    # ------------------------------------------------------------------
    # Rollback
    # ------------------------------------------------------------------

    async def rollback(self, deployment_id: str, reason: str) -> bool:
        record = self._deployments.get(deployment_id)
        if not record:
            return False

        record.current_stage = DeploymentStage.ROLLED_BACK
        record.updated_at = datetime.now(timezone.utc).isoformat()

        self._sb.update_automation_status(
            deployment_id, "rolled_back", shadow_report={"reason": reason},
        )

        return True

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    def get_deployment(self, deployment_id: str) -> DeploymentRecord | None:
        return self._deployments.get(deployment_id)

    def get_active_deployments(self) -> list[DeploymentRecord]:
        return [
            d for d in self._deployments.values()
            if d.current_stage not in (DeploymentStage.FULL, DeploymentStage.ROLLED_BACK)
        ]
