"""Windows platform service implementation."""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

from vincera.platform._base import PlatformService, ServiceStatus, _run_cmd
from vincera.platform._models import (
    DiscoveryResult,
    ShareInfo,
    SoftwareInfo,
    TaskInfo,
)

_SERVICE_PREFIX = "Vincera"


class WindowsPlatformService(PlatformService):
    """Windows-specific platform service using sc.exe, schtasks, etc."""

    # --- helpers ---

    def _service_name(self, name: str) -> str:
        return f"{_SERVICE_PREFIX}-{name}"

    # --- service management ---

    def install_service(
        self, name: str, python_command: str, description: str
    ) -> bool:
        svc_name = self._service_name(name)

        # Try NSSM first (better for Python services), fall back to sc.exe
        nssm = _run_cmd(["nssm", "install", svc_name, python_command])
        if nssm is not None and nssm.returncode == 0:
            _run_cmd(["nssm", "set", svc_name, "Description", description])
            _run_cmd(["nssm", "start", svc_name])
            return True

        # Fallback: sc.exe
        result = _run_cmd([
            "sc.exe", "create", svc_name,
            f"binPath={python_command}",
            "start=auto",
        ])
        if result is None or result.returncode != 0:
            return False

        _run_cmd(["sc.exe", "description", svc_name, description])
        _run_cmd(["sc.exe", "start", svc_name])
        return True

    def uninstall_service(self, name: str) -> bool:
        svc_name = self._service_name(name)
        _run_cmd(["sc.exe", "stop", svc_name])
        result = _run_cmd(["sc.exe", "delete", svc_name])
        return result is not None and result.returncode == 0

    def get_service_status(self, name: str) -> ServiceStatus:
        svc_name = self._service_name(name)
        result = _run_cmd(["sc.exe", "query", svc_name])
        if result is None or result.returncode != 0:
            return "not_installed"

        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("STATE"):
                if "RUNNING" in line:
                    return "running"
                elif "STOPPED" in line:
                    return "stopped"
        return "not_installed"

    def start_service(self, name: str) -> bool:
        result = _run_cmd(["sc.exe", "start", self._service_name(name)])
        return result is not None and result.returncode == 0

    def stop_service(self, name: str) -> bool:
        result = _run_cmd(["sc.exe", "stop", self._service_name(name)])
        return result is not None and result.returncode == 0

    # --- software discovery ---

    def _collect_registry(self) -> tuple[list[SoftwareInfo], list[str]]:
        reg_path = r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
        result = _run_cmd(["reg", "query", reg_path, "/s"])
        if result is None:
            return [], ["registry: command failed"]

        items: list[SoftwareInfo] = []
        current_name: str | None = None
        current_version: str | None = None

        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("DisplayName"):
                parts = line.split("REG_SZ", 1)
                if len(parts) == 2:
                    current_name = parts[1].strip()
            elif line.startswith("DisplayVersion"):
                parts = line.split("REG_SZ", 1)
                if len(parts) == 2:
                    current_version = parts[1].strip()
            elif not line and current_name:
                items.append(
                    SoftwareInfo(
                        name=current_name, version=current_version, source="registry"
                    )
                )
                current_name = None
                current_version = None

        if current_name:
            items.append(
                SoftwareInfo(
                    name=current_name, version=current_version, source="registry"
                )
            )
        return items, []

    def _collect_winget(self) -> tuple[list[SoftwareInfo], list[str]]:
        result = _run_cmd(["winget", "list", "--disable-interactivity"])
        if result is None:
            return [], ["winget: command not found or failed"]

        items: list[SoftwareInfo] = []
        lines = result.stdout.strip().splitlines()
        # Skip header lines (winget outputs decorative lines)
        data_started = False
        for line in lines:
            if "----" in line:
                data_started = True
                continue
            if not data_started or not line.strip():
                continue
            # Winget output is column-aligned, rough parse
            parts = line.split()
            if len(parts) >= 2:
                name = parts[0]
                version = parts[-1] if len(parts) > 1 else None
                items.append(
                    SoftwareInfo(name=name, version=version, source="winget")
                )
        return items, []

    def _collect_pip(self) -> tuple[list[SoftwareInfo], list[str]]:
        result = _run_cmd(["pip", "list", "--format=json"])
        if result is None:
            return [], ["pip: command not found or failed"]

        items: list[SoftwareInfo] = []
        try:
            for pkg in json.loads(result.stdout):
                items.append(
                    SoftwareInfo(
                        name=pkg["name"], version=pkg.get("version"), source="pip"
                    )
                )
        except (json.JSONDecodeError, KeyError) as exc:
            return items, [f"pip: parse error: {exc}"]
        return items, []

    def _collect_npm(self) -> tuple[list[SoftwareInfo], list[str]]:
        result = _run_cmd(["npm", "-g", "list", "--json"])
        if result is None:
            return [], ["npm: command not found or failed"]

        items: list[SoftwareInfo] = []
        try:
            data = json.loads(result.stdout)
            for name, info in data.get("dependencies", {}).items():
                items.append(
                    SoftwareInfo(name=name, version=info.get("version"), source="npm")
                )
        except (json.JSONDecodeError, KeyError) as exc:
            return items, [f"npm: parse error: {exc}"]
        return items, []

    def list_installed_software(self) -> DiscoveryResult[SoftwareInfo]:
        all_items: list[SoftwareInfo] = []
        all_errors: list[str] = []

        for collector in (
            self._collect_registry,
            self._collect_winget,
            self._collect_pip,
            self._collect_npm,
        ):
            items, errors = collector()
            all_items.extend(items)
            all_errors.extend(errors)

        return DiscoveryResult[SoftwareInfo](
            items=all_items,
            complete=len(all_errors) == 0,
            errors=all_errors,
        )

    # --- network shares ---

    def list_network_shares(self) -> DiscoveryResult[ShareInfo]:
        items: list[ShareInfo] = []
        errors: list[str] = []

        # Local shares: net share
        result = _run_cmd(["net", "share"])
        if result is None:
            errors.append("net share: command failed")
        else:
            for line in result.stdout.strip().splitlines()[4:]:  # skip headers
                parts = line.split()
                if len(parts) >= 2 and not line.startswith("The command"):
                    items.append(
                        ShareInfo(
                            name=parts[0],
                            path=parts[1] if len(parts) > 1 else "",
                            share_type="local",
                        )
                    )

        # Mapped drives: net use
        result = _run_cmd(["net", "use"])
        if result is None:
            errors.append("net use: command failed")
        else:
            for line in result.stdout.strip().splitlines():
                parts = line.split()
                if len(parts) >= 3 and parts[0] in ("OK", "Disconnected", "Unavailable"):
                    local = parts[1]
                    remote = parts[2]
                    items.append(
                        ShareInfo(
                            name=local,
                            path=local,
                            share_type="smb",
                            remote=remote,
                        )
                    )

        return DiscoveryResult[ShareInfo](
            items=items,
            complete=len(errors) == 0,
            errors=errors,
        )

    # --- scheduled tasks ---

    def list_scheduled_tasks(self) -> DiscoveryResult[TaskInfo]:
        items: list[TaskInfo] = []
        errors: list[str] = []

        result = _run_cmd(["schtasks", "/query", "/fo", "CSV", "/nh"])
        if result is None:
            errors.append("schtasks: command failed")
        else:
            try:
                reader = csv.reader(io.StringIO(result.stdout))
                for row in reader:
                    if len(row) >= 3:
                        items.append(
                            TaskInfo(
                                name=row[0].strip('"'),
                                schedule=row[1].strip('"') if len(row) > 1 else None,
                                status=row[2].strip('"') if len(row) > 2 else None,
                            )
                        )
            except csv.Error as exc:
                errors.append(f"schtasks: parse error: {exc}")

        return DiscoveryResult[TaskInfo](
            items=items,
            complete=len(errors) == 0,
            errors=errors,
        )
