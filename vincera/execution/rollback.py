"""Rollback Manager — handles reverting deployments."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.execution.deployment_pipeline import DeploymentPipeline
    from vincera.execution.monitor import DeploymentMonitor
    from vincera.knowledge.supabase_client import SupabaseManager

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class RollbackRecord(BaseModel):
    """Record of a single rollback event."""

    rollback_id: str
    deployment_id: str
    trigger: str  # "auto" or "manual"
    reason: str
    rolled_back_from_stage: str
    timestamp: str


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------

class RollbackManager:
    """Manages deployment rollbacks — both automatic and manual."""

    def __init__(
        self,
        pipeline: DeploymentPipeline,
        monitor: DeploymentMonitor,
        supabase: SupabaseManager,
        company_id: str,
    ) -> None:
        self._pipeline = pipeline
        self._monitor = monitor
        self._sb = supabase
        self._company_id = company_id
        self._history: list[RollbackRecord] = []

    # ------------------------------------------------------------------
    # Core rollback
    # ------------------------------------------------------------------

    async def _rollback(
        self,
        deployment_id: str,
        reason: str,
        trigger: str,
    ) -> RollbackRecord:
        # Capture stage before rollback
        deployment = self._pipeline.get_deployment(deployment_id)
        from_stage = deployment.current_stage.value if deployment else "unknown"

        # Delegate to pipeline
        await self._pipeline.rollback(deployment_id, reason)

        now = datetime.now(timezone.utc).isoformat()
        record = RollbackRecord(
            rollback_id=str(uuid.uuid4())[:8],
            deployment_id=deployment_id,
            trigger=trigger,
            reason=reason,
            rolled_back_from_stage=from_stage,
            timestamp=now,
        )
        self._history.append(record)

        self._sb.log_event(
            self._company_id,
            "rollback",
            "rollback_manager",
            f"{trigger} rollback of {deployment_id} from {from_stage}: {reason}",
        )

        return record

    # ------------------------------------------------------------------
    # Auto rollback (triggered by monitor)
    # ------------------------------------------------------------------

    async def auto_rollback(self, deployment_id: str, reason: str) -> RollbackRecord:
        return await self._rollback(deployment_id, reason, trigger="auto")

    # ------------------------------------------------------------------
    # Manual rollback (triggered by user/agent)
    # ------------------------------------------------------------------

    async def manual_rollback(self, deployment_id: str, reason: str) -> RollbackRecord:
        return await self._rollback(deployment_id, reason, trigger="manual")

    # ------------------------------------------------------------------
    # Check and rollback
    # ------------------------------------------------------------------

    async def check_and_rollback(self, deployment_id: str) -> RollbackRecord | None:
        should = await self._monitor.should_rollback(deployment_id)
        if not should:
            return None
        return await self.auto_rollback(
            deployment_id, "Monitor detected FAILING health status",
        )

    # ------------------------------------------------------------------
    # History
    # ------------------------------------------------------------------

    def get_history(self, deployment_id: str | None = None) -> list[RollbackRecord]:
        if deployment_id is None:
            return list(self._history)
        return [r for r in self._history if r.deployment_id == deployment_id]
