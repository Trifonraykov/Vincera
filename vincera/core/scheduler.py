"""Scheduler — timing control, recurring tasks, and the main event loop."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.config import VinceraSettings
    from vincera.core.orchestrator import Orchestrator
    from vincera.core.state import GlobalState

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class ScheduledTask(BaseModel):
    """A task registered with the scheduler."""

    task_id: str
    name: str
    callback_name: str
    interval_seconds: int  # 0 = one-shot
    last_run: datetime | None = None
    next_run: datetime
    enabled: bool = True
    run_count: int = 0


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

class Scheduler:
    """Controls timing: main loop, recurring tasks, cron-style scheduling."""

    def __init__(
        self,
        orchestrator: Orchestrator,
        config: VinceraSettings,
        state: GlobalState,
    ) -> None:
        self._orchestrator = orchestrator
        self._config = config
        self._state = state
        self._tasks: dict[str, ScheduledTask] = {}
        self._running: bool = False
        self._cycle_interval: int = 300  # 5 minutes

    # ------------------------------------------------------------------
    # Task management
    # ------------------------------------------------------------------

    def add_task(
        self,
        task_id: str,
        name: str,
        callback_name: str,
        interval_seconds: int,
        start_delay_seconds: int = 0,
    ) -> None:
        next_run = datetime.now(timezone.utc) + timedelta(seconds=start_delay_seconds)
        self._tasks[task_id] = ScheduledTask(
            task_id=task_id,
            name=name,
            callback_name=callback_name,
            interval_seconds=interval_seconds,
            next_run=next_run,
        )

    def remove_task(self, task_id: str) -> None:
        self._tasks.pop(task_id, None)

    def get_due_tasks(self) -> list[ScheduledTask]:
        now = datetime.now(timezone.utc)
        return [t for t in self._tasks.values() if t.enabled and t.next_run <= now]

    # ------------------------------------------------------------------
    # Tick
    # ------------------------------------------------------------------

    async def tick(self) -> list[dict]:
        if self._state.is_paused():
            return [{"action": "paused"}]

        results: list[dict] = []
        due = self.get_due_tasks()

        for task in due:
            try:
                result = await self._execute_task(task)
                results.append({"task": task.name, "result": result})
                task.last_run = datetime.now(timezone.utc)
                task.run_count += 1
                if task.interval_seconds > 0:
                    task.next_run = datetime.now(timezone.utc) + timedelta(
                        seconds=task.interval_seconds,
                    )
                else:
                    task.enabled = False
            except Exception as exc:
                logger.error("Scheduler task %s failed: %s", task.name, exc)
                results.append({"task": task.name, "error": str(exc)})

        return results

    async def _execute_task(self, task: ScheduledTask) -> dict:
        callbacks = {
            "orchestrator_cycle": self._orchestrator.run_cycle,
            "ghost_daily_report": self._ghost_daily_report,
            "health_check": self._health_check,
            "flush_queue": self._flush_queue,
        }
        callback = callbacks.get(task.callback_name)
        if callback:
            return await callback()
        return {"error": f"Unknown callback: {task.callback_name}"}

    # ------------------------------------------------------------------
    # Built-in callbacks
    # ------------------------------------------------------------------

    async def _ghost_daily_report(self) -> dict:
        return {"action": "ghost_report_delegated"}

    async def _health_check(self) -> dict:
        return {"action": "health_ok", "cycle": self._orchestrator._brain.cycle_count}

    async def _flush_queue(self) -> dict:
        self._state.flush_queue()
        return {"action": "queue_flushed"}

    # ------------------------------------------------------------------
    # Default schedule
    # ------------------------------------------------------------------

    def setup_default_schedule(self) -> None:
        self.add_task(
            "orch_cycle", "Orchestrator Cycle", "orchestrator_cycle",
            interval_seconds=self._cycle_interval,
        )
        self.add_task(
            "health", "Health Check", "health_check",
            interval_seconds=900,
        )
        self.add_task(
            "flush", "Flush Queue", "flush_queue",
            interval_seconds=120,
        )

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    async def run_loop(self) -> None:
        self._running = True
        while self._running:
            await self.tick()
            enabled = [t for t in self._tasks.values() if t.enabled]
            sleep_for = min(t.interval_seconds for t in enabled) if enabled else 60
            await asyncio.sleep(max(sleep_for, 1))

    def stop(self) -> None:
        self._running = False

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def task_count(self) -> int:
        return len(self._tasks)

    @property
    def enabled_task_count(self) -> int:
        return sum(1 for t in self._tasks.values() if t.enabled)
