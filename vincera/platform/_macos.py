"""macOS platform service implementation."""

from __future__ import annotations

import json
import plistlib
import shlex
from pathlib import Path

from vincera.platform._base import PlatformService, ServiceStatus, _run_cmd
from vincera.platform._models import (
    DiscoveryResult,
    ShareInfo,
    SoftwareInfo,
    TaskInfo,
)

_LABEL_PREFIX = "com.vincera"


class MacOSPlatformService(PlatformService):
    """macOS-specific platform service using launchctl, brew, etc."""

    # --- helpers ---

    def _launch_agents_dir(self) -> Path:
        return Path.home() / "Library" / "LaunchAgents"

    def _label(self, name: str) -> str:
        return f"{_LABEL_PREFIX}.{name}"

    def _plist_path(self, name: str) -> Path:
        return self._launch_agents_dir() / f"{self._label(name)}.plist"

    # --- service management ---

    def install_service(
        self, name: str, python_command: str, description: str
    ) -> bool:
        label = self._label(name)
        args = shlex.split(python_command)
        plist_dir = self._launch_agents_dir()
        plist_dir.mkdir(parents=True, exist_ok=True)
        plist_file = plist_dir / f"{label}.plist"

        plist_data = {
            "Label": label,
            "ProgramArguments": args,
            "RunAtLoad": True,
            "KeepAlive": True,
            "StandardOutPath": f"/tmp/{label}.stdout.log",
            "StandardErrorPath": f"/tmp/{label}.stderr.log",
        }

        try:
            plist_file.write_bytes(plistlib.dumps(plist_data, fmt=plistlib.FMT_XML))
        except OSError:
            return False

        result = _run_cmd(["launchctl", "load", str(plist_file)])
        if result is None or result.returncode != 0:
            return False
        return True

    def uninstall_service(self, name: str) -> bool:
        plist_file = self._plist_path(name)
        if plist_file.exists():
            _run_cmd(["launchctl", "unload", str(plist_file)])
            try:
                plist_file.unlink()
            except OSError:
                return False
        return True

    def get_service_status(self, name: str) -> ServiceStatus:
        label = self._label(name)
        result = _run_cmd(["launchctl", "list"])
        if result is None:
            return "not_installed"

        for line in result.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) >= 3 and parts[2] == label:
                pid = parts[0].strip()
                if pid != "-" and pid.isdigit():
                    return "running"
                return "stopped"
        return "not_installed"

    def start_service(self, name: str) -> bool:
        result = _run_cmd(["launchctl", "start", self._label(name)])
        return result is not None and result.returncode == 0

    def stop_service(self, name: str) -> bool:
        result = _run_cmd(["launchctl", "stop", self._label(name)])
        return result is not None and result.returncode == 0

    # --- software discovery ---

    def _collect_brew(self) -> tuple[list[SoftwareInfo], list[str]]:
        result = _run_cmd(["brew", "list", "--versions"])
        if result is None:
            return [], ["brew: command not found or failed"]
        if result.returncode != 0:
            return [], [f"brew: exit code {result.returncode}"]

        items: list[SoftwareInfo] = []
        for line in result.stdout.strip().splitlines():
            parts = line.split()
            if parts:
                name = parts[0]
                version = parts[1] if len(parts) > 1 else None
                items.append(SoftwareInfo(name=name, version=version, source="brew"))
        return items, []

    def _collect_applications(self) -> tuple[list[SoftwareInfo], list[str]]:
        apps_dir = Path("/Applications")
        items: list[SoftwareInfo] = []
        if not apps_dir.exists():
            return [], ["Applications directory not found"]

        try:
            for app in apps_dir.glob("*.app"):
                items.append(
                    SoftwareInfo(name=app.stem, version=None, source="app_bundle")
                )
        except PermissionError as exc:
            return items, [f"Applications: {exc}"]
        return items, []

    def _collect_pip(self) -> tuple[list[SoftwareInfo], list[str]]:
        result = _run_cmd(["pip", "list", "--format=json"])
        if result is None:
            return [], ["pip: command not found or failed"]
        if result.returncode != 0:
            return [], [f"pip: exit code {result.returncode}"]

        items: list[SoftwareInfo] = []
        try:
            for pkg in json.loads(result.stdout):
                items.append(
                    SoftwareInfo(
                        name=pkg["name"],
                        version=pkg.get("version"),
                        source="pip",
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
            deps = data.get("dependencies", {})
            for name, info in deps.items():
                items.append(
                    SoftwareInfo(
                        name=name,
                        version=info.get("version"),
                        source="npm",
                    )
                )
        except (json.JSONDecodeError, KeyError) as exc:
            return items, [f"npm: parse error: {exc}"]
        return items, []

    def list_installed_software(self) -> DiscoveryResult[SoftwareInfo]:
        all_items: list[SoftwareInfo] = []
        all_errors: list[str] = []

        for collector in (
            self._collect_brew,
            self._collect_applications,
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

        result = _run_cmd(["mount"])
        if result is None:
            errors.append("mount: command failed")
        else:
            for line in result.stdout.strip().splitlines():
                # Format: device on mountpoint (type, options)
                parts = line.split(" on ", 1)
                if len(parts) != 2:
                    continue
                device = parts[0].strip()
                rest = parts[1]
                # Split mountpoint from (type, ...)
                paren_idx = rest.rfind("(")
                if paren_idx == -1:
                    continue
                mountpoint = rest[:paren_idx].strip()
                type_info = rest[paren_idx + 1 :].rstrip(")")
                share_type = type_info.split(",")[0].strip()

                items.append(
                    ShareInfo(
                        name=Path(mountpoint).name or mountpoint,
                        path=mountpoint,
                        share_type=share_type,
                        remote=device if share_type in ("nfs", "smbfs", "cifs") else None,
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

        result = _run_cmd(["launchctl", "list"])
        if result is None:
            errors.append("launchctl: command failed")
        else:
            for line in result.stdout.strip().splitlines():
                parts = line.split("\t")
                if len(parts) < 3:
                    continue
                pid_str, _status, label = parts[0].strip(), parts[1].strip(), parts[2].strip()
                if label == "Label":
                    continue  # header

                if pid_str != "-" and pid_str.isdigit():
                    status = "running"
                else:
                    status = "stopped"

                items.append(
                    TaskInfo(name=label, status=status)
                )

        return DiscoveryResult[TaskInfo](
            items=items,
            complete=len(errors) == 0,
            errors=errors,
        )
