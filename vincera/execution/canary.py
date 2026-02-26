"""Canary Executor — runs a subset of traffic through new automations."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.execution.sandbox import DockerSandbox
    from vincera.knowledge.supabase_client import SupabaseManager

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class CanaryStatus(str, Enum):
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    ABORTED = "aborted"


class CanaryExecution(BaseModel):
    """Single canary execution record."""

    execution_id: str
    deployment_id: str
    success: bool
    metadata: dict | None = None
    timestamp: str


class CanaryState(BaseModel):
    """Current state of a canary deployment."""

    deployment_id: str
    status: CanaryStatus
    canary_percentage: int
    script: str
    total_executions: int = 0
    successful_executions: int = 0
    failed_executions: int = 0
    started_at: str
    updated_at: str


# ---------------------------------------------------------------------------
# Executor
# ---------------------------------------------------------------------------

class CanaryExecutor:
    """Manages canary deployments — running a small percentage of traffic."""

    def __init__(
        self,
        sandbox: DockerSandbox,
        supabase: SupabaseManager,
        company_id: str,
    ) -> None:
        self._sandbox = sandbox
        self._sb = supabase
        self._company_id = company_id
        self._states: dict[str, CanaryState] = {}

    # ------------------------------------------------------------------
    # Start
    # ------------------------------------------------------------------

    async def start_canary(
        self,
        deployment_id: str,
        script: str,
        canary_percentage: int = 10,
    ) -> CanaryState:
        now = datetime.now(timezone.utc).isoformat()
        state = CanaryState(
            deployment_id=deployment_id,
            status=CanaryStatus.RUNNING,
            canary_percentage=canary_percentage,
            script=script,
            started_at=now,
            updated_at=now,
        )
        self._states[deployment_id] = state

        self._sb.log_event(
            self._company_id,
            "canary",
            "canary_executor",
            f"Started canary for deployment {deployment_id} at {canary_percentage}%",
        )

        return state

    # ------------------------------------------------------------------
    # Record execution
    # ------------------------------------------------------------------

    async def record_execution(
        self,
        deployment_id: str,
        success: bool,
        metadata: dict | None = None,
    ) -> CanaryExecution:
        state = self._states[deployment_id]
        now = datetime.now(timezone.utc).isoformat()

        execution = CanaryExecution(
            execution_id=str(uuid.uuid4())[:8],
            deployment_id=deployment_id,
            success=success,
            metadata=metadata,
            timestamp=now,
        )

        state.total_executions += 1
        if success:
            state.successful_executions += 1
        else:
            state.failed_executions += 1
        state.updated_at = now

        return execution

    # ------------------------------------------------------------------
    # Evaluate
    # ------------------------------------------------------------------

    async def evaluate(
        self,
        deployment_id: str,
        min_executions: int = 5,
        success_threshold: float = 0.9,
    ) -> CanaryStatus:
        state = self._states[deployment_id]

        if state.status in (CanaryStatus.ABORTED, CanaryStatus.PASSED, CanaryStatus.FAILED):
            return state.status

        if state.total_executions < min_executions:
            return CanaryStatus.RUNNING

        success_rate = state.successful_executions / state.total_executions
        if success_rate >= success_threshold:
            state.status = CanaryStatus.PASSED
        else:
            state.status = CanaryStatus.FAILED

        state.updated_at = datetime.now(timezone.utc).isoformat()
        return state.status

    # ------------------------------------------------------------------
    # Abort
    # ------------------------------------------------------------------

    async def abort(self, deployment_id: str, reason: str) -> CanaryState:
        state = self._states[deployment_id]
        state.status = CanaryStatus.ABORTED
        state.updated_at = datetime.now(timezone.utc).isoformat()

        self._sb.log_event(
            self._company_id,
            "canary",
            "canary_executor",
            f"Aborted canary {deployment_id}: {reason}",
        )

        return state

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    def get_state(self, deployment_id: str) -> CanaryState | None:
        return self._states.get(deployment_id)
