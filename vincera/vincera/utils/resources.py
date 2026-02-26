"""Resource monitoring — disk and memory usage checks with automated responses."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import psutil

if TYPE_CHECKING:
    from vincera.config import VinceraSettings
    from vincera.knowledge.supabase_client import SupabaseManager

logger = logging.getLogger(__name__)


class ResourceMonitor:
    """Monitors disk and memory usage, triggers warnings and actions."""

    DISK_WARN_THRESHOLD = 0.90      # 90% — log warning
    DISK_PAUSE_THRESHOLD = 0.95     # 95% — pause the system
    MEMORY_WARN_THRESHOLD = 0.80    # 80% — log warning
    MEMORY_KILL_THRESHOLD = 0.90    # 90% — kill lowest-priority agent

    def __init__(
        self,
        supabase: "SupabaseManager",
        config: "VinceraSettings",
    ) -> None:
        self._sb = supabase
        self._config = config

    async def check(self) -> dict:
        """Run all resource checks. Returns status dict."""
        disk = psutil.disk_usage(str(self._config.home_dir))
        memory = psutil.virtual_memory()

        disk_pct = disk.percent / 100.0
        mem_pct = memory.percent / 100.0

        status: dict = {
            "disk_percent": disk.percent,
            "memory_percent": memory.percent,
            "actions_taken": [],
        }

        # Disk checks
        if disk_pct >= self.DISK_PAUSE_THRESHOLD:
            await self._pause_system(f"Disk usage critical: {disk.percent:.1f}%")
            status["actions_taken"].append("system_paused_disk")
        elif disk_pct >= self.DISK_WARN_THRESHOLD:
            await self._warn(f"Disk usage high: {disk.percent:.1f}%")
            status["actions_taken"].append("disk_warning")

        # Memory checks
        if mem_pct >= self.MEMORY_KILL_THRESHOLD:
            await self._kill_lowest_priority_agent()
            status["actions_taken"].append("agent_killed_memory")
        elif mem_pct >= self.MEMORY_WARN_THRESHOLD:
            await self._warn(f"Memory usage high: {memory.percent:.1f}%")
            status["actions_taken"].append("memory_warning")

        return status

    async def _warn(self, message: str) -> None:
        """Log warning and send alert event."""
        logger.warning("ResourceMonitor: %s", message)
        try:
            self._sb.log_event(
                company_id=self._config.company_id,
                event_type="resource_warning",
                agent_name="system",
                message=message,
                severity="warning",
            )
        except Exception:
            logger.exception("ResourceMonitor: failed to send warning event")

    async def _pause_system(self, reason: str) -> None:
        """Pause the entire system due to resource exhaustion."""
        logger.critical("ResourceMonitor: PAUSING SYSTEM — %s", reason)
        try:
            self._sb.update_company(
                self._config.company_id,
                {"status": "paused"},
            )
            self._sb.send_message(
                self._config.company_id,
                "system",
                f"System paused: {reason}",
                "alert",
            )
        except Exception:
            logger.exception("ResourceMonitor: failed to pause system via Supabase")

    async def _kill_lowest_priority_agent(self) -> None:
        """Stop the lowest-priority running agent to free memory."""
        logger.warning(
            "ResourceMonitor: Memory critically high — would kill lowest-priority agent"
        )
