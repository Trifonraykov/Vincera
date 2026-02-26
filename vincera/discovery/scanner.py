"""System scanner: environment, software, processes, scheduled tasks."""

from __future__ import annotations

import logging
import platform
import shutil
import subprocess
import time
from typing import Generic, TypeVar

import psutil
from pydantic import BaseModel

from vincera.platform import PlatformService

logger = logging.getLogger(__name__)

T = TypeVar("T")


class ScanResult(BaseModel, Generic[T]):
    """Generic scan result wrapper."""

    data: T
    completeness_flag: bool = True
    scan_duration_ms: int = 0
    errors: list[str] = []


class EnvironmentInfo(BaseModel):
    """System environment information."""

    os_name: str
    os_version: str
    hostname: str
    cpu_model: str
    cpu_cores: int
    ram_total_gb: float
    ram_available_gb: float
    disk_partitions: list[dict] = []
    docker_available: bool = False
    python_version: str
    node_version: str | None = None
    network_interfaces: list[dict] = []


# ------------------------------------------------------------------
# Software categorization
# ------------------------------------------------------------------

_SOFTWARE_CATEGORIES: dict[str, str] = {
    "postgres": "database", "postgresql": "database", "mysql": "database",
    "mariadb": "database", "redis": "database", "mongodb": "database",
    "mongo": "database", "sqlite": "database", "sqlserver": "database",
    "nginx": "web_server", "apache": "web_server", "httpd": "web_server",
    "caddy": "web_server", "lighttpd": "web_server",
    "vscode": "ide", "code": "ide", "idea": "ide", "pycharm": "ide",
    "webstorm": "ide", "sublime": "ide", "atom": "ide", "vim": "ide",
    "neovim": "ide", "emacs": "ide", "xcode": "ide",
    "quickbooks": "accounting", "sage": "accounting", "xero": "accounting",
    "freshbooks": "accounting", "wave": "accounting",
    "slack": "communication", "teams": "communication", "zoom": "communication",
    "discord": "communication", "telegram": "communication",
    "python": "development", "node": "development", "npm": "development",
    "git": "development", "docker": "development", "go": "development",
    "rust": "development", "java": "development", "ruby": "development",
    "php": "development", "gcc": "development", "cmake": "development",
    "excel": "office", "word": "office", "powerpoint": "office",
    "libreoffice": "office", "pages": "office", "numbers": "office",
    "keynote": "office",
}

_PROCESS_CATEGORIES: dict[str, str] = {
    "postgres": "database", "postgresql": "database", "mysql": "database",
    "mysqld": "database", "mariadbd": "database", "mongod": "database",
    "redis-server": "database", "redis": "database", "sqlservr": "database",
    "nginx": "web_server", "apache": "web_server", "apache2": "web_server",
    "httpd": "web_server",
    "gunicorn": "app_server", "uvicorn": "app_server", "node": "app_server",
    "java": "app_server", "tomcat": "app_server",
    "dockerd": "container", "containerd": "container",
}


def _categorize_software(name: str) -> str:
    """Categorize a software package by name."""
    name_lower = name.lower().replace("-", "").replace("_", "").replace(" ", "")
    for key, category in _SOFTWARE_CATEGORIES.items():
        if key in name_lower:
            return category
    return "other"


def _categorize_process(name: str) -> str | None:
    """Categorize a running process by name."""
    name_lower = name.lower()
    for key, category in _PROCESS_CATEGORIES.items():
        if key == name_lower or name_lower.startswith(key):
            return category
    return None


class SystemScanner:
    """Cross-platform system scanner."""

    def __init__(self, platform_service: PlatformService) -> None:
        self._platform = platform_service

    async def scan_environment(self) -> EnvironmentInfo:
        """Scan system environment: OS, CPU, RAM, disk, Docker, versions."""
        mem = psutil.virtual_memory()
        partitions = []
        for p in psutil.disk_partitions(all=False):
            try:
                usage = psutil.disk_usage(p.mountpoint)
                partitions.append({
                    "device": p.device,
                    "mountpoint": p.mountpoint,
                    "fstype": p.fstype,
                    "total_gb": round(usage.total / (1024**3), 2),
                    "used_gb": round(usage.used / (1024**3), 2),
                    "free_gb": round(usage.free / (1024**3), 2),
                })
            except (PermissionError, OSError):
                continue

        interfaces = []
        for name, addrs in psutil.net_if_addrs().items():
            for addr in addrs:
                if addr.family.name == "AF_INET":
                    interfaces.append({"name": name, "address": addr.address})

        # Node version
        node_version = None
        try:
            result = subprocess.run(
                ["node", "--version"], capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0:
                node_version = result.stdout.strip()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        return EnvironmentInfo(
            os_name=platform.system(),
            os_version=platform.release(),
            hostname=platform.node(),
            cpu_model=platform.processor() or "unknown",
            cpu_cores=psutil.cpu_count(logical=True) or 1,
            ram_total_gb=round(mem.total / (1024**3), 2),
            ram_available_gb=round(mem.available / (1024**3), 2),
            disk_partitions=partitions,
            docker_available=shutil.which("docker") is not None,
            python_version=platform.python_version(),
            node_version=node_version,
            network_interfaces=interfaces,
        )

    async def scan_installed_software(self) -> ScanResult[list[dict]]:
        """Scan installed software and enrich with categories."""
        start = time.monotonic()
        result = self._platform.list_installed_software()
        duration_ms = int((time.monotonic() - start) * 1000)

        enriched = []
        for item in result.items:
            entry = item.model_dump()
            entry["category"] = _categorize_software(item.name)
            enriched.append(entry)

        return ScanResult(
            data=enriched,
            completeness_flag=result.complete,
            scan_duration_ms=duration_ms,
            errors=result.errors,
        )

    async def scan_running_processes(self) -> ScanResult[list[dict]]:
        """Scan running processes and tag known services."""
        start = time.monotonic()
        result = self._platform.list_running_processes()
        duration_ms = int((time.monotonic() - start) * 1000)

        enriched = []
        for item in result.items:
            entry = item.model_dump()
            entry["category"] = _categorize_process(item.name)
            enriched.append(entry)

        return ScanResult(
            data=enriched,
            completeness_flag=result.complete,
            scan_duration_ms=duration_ms,
            errors=result.errors,
        )

    async def scan_scheduled_tasks(self) -> ScanResult[list[dict]]:
        """Scan scheduled tasks."""
        start = time.monotonic()
        result = self._platform.list_scheduled_tasks()
        duration_ms = int((time.monotonic() - start) * 1000)

        return ScanResult(
            data=[item.model_dump() for item in result.items],
            completeness_flag=result.complete,
            scan_duration_ms=duration_ms,
            errors=result.errors,
        )
