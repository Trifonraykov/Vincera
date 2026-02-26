"""Abstract base class for platform services."""

from __future__ import annotations

import subprocess
from abc import ABC, abstractmethod
from typing import Literal

import psutil

from vincera.platform._models import (
    DiscoveryResult,
    ProcessInfo,
    ShareInfo,
    SoftwareInfo,
    TaskInfo,
)

ServiceStatus = Literal["running", "stopped", "not_installed"]


def _run_cmd(
    args: list[str],
    timeout: int = 30,
    **kwargs: object,
) -> subprocess.CompletedProcess[str] | None:
    """Run a subprocess command, returning None on any expected failure."""
    try:
        return subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            **kwargs,
        )
    except (FileNotFoundError, PermissionError, subprocess.TimeoutExpired):
        return None


class PlatformService(ABC):
    """Abstract cross-platform service manager and system discovery."""

    # --- Service management ---

    @abstractmethod
    def install_service(
        self, name: str, python_command: str, description: str
    ) -> bool: ...

    @abstractmethod
    def uninstall_service(self, name: str) -> bool: ...

    @abstractmethod
    def get_service_status(self, name: str) -> ServiceStatus: ...

    @abstractmethod
    def start_service(self, name: str) -> bool: ...

    @abstractmethod
    def stop_service(self, name: str) -> bool: ...

    # --- System discovery ---

    @abstractmethod
    def list_installed_software(self) -> DiscoveryResult[SoftwareInfo]: ...

    def list_running_processes(self) -> DiscoveryResult[ProcessInfo]:
        """List running processes via psutil (cross-platform)."""
        items: list[ProcessInfo] = []
        errors: list[str] = []
        try:
            for proc in psutil.process_iter(
                ["pid", "name", "username", "cpu_percent", "memory_percent", "cmdline"]
            ):
                try:
                    info = proc.info
                    items.append(
                        ProcessInfo(
                            pid=info["pid"],
                            name=info["name"] or "",
                            user=info.get("username"),
                            cpu_percent=info.get("cpu_percent"),
                            memory_percent=info.get("memory_percent"),
                            cmdline=info.get("cmdline") or [],
                        )
                    )
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
        except Exception as exc:
            errors.append(f"psutil: {exc}")

        return DiscoveryResult[ProcessInfo](
            items=items,
            complete=len(errors) == 0,
            errors=errors,
        )

    @abstractmethod
    def list_network_shares(self) -> DiscoveryResult[ShareInfo]: ...

    @abstractmethod
    def list_scheduled_tasks(self) -> DiscoveryResult[TaskInfo]: ...
