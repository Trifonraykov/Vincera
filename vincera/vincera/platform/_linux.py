"""Linux platform service implementation."""

from __future__ import annotations

import json
import shlex
import textwrap
from pathlib import Path

from vincera.platform._base import PlatformService, ServiceStatus, _run_cmd
from vincera.platform._models import (
    DiscoveryResult,
    ShareInfo,
    SoftwareInfo,
    TaskInfo,
)

_SERVICE_PREFIX = "vincera"


class LinuxPlatformService(PlatformService):
    """Linux-specific platform service using systemd, dpkg, etc."""

    # --- helpers ---

    def _systemd_user_dir(self) -> Path:
        return Path.home() / ".config" / "systemd" / "user"

    def _unit_name(self, name: str) -> str:
        return f"{_SERVICE_PREFIX}-{name}.service"

    def _unit_path(self, name: str) -> Path:
        return self._systemd_user_dir() / self._unit_name(name)

    # --- service management ---

    def install_service(
        self, name: str, python_command: str, description: str
    ) -> bool:
        unit_dir = self._systemd_user_dir()
        unit_dir.mkdir(parents=True, exist_ok=True)
        unit_file = unit_dir / self._unit_name(name)

        unit_content = textwrap.dedent(f"""\
            [Unit]
            Description={description}

            [Service]
            ExecStart={python_command}
            Restart=always
            RestartSec=10

            [Install]
            WantedBy=default.target
        """)

        try:
            unit_file.write_text(unit_content)
        except OSError:
            return False

        _run_cmd(["systemctl", "--user", "daemon-reload"])
        result = _run_cmd(["systemctl", "--user", "enable", "--now", self._unit_name(name)])
        if result is None or result.returncode != 0:
            return False
        return True

    def uninstall_service(self, name: str) -> bool:
        unit_name = self._unit_name(name)
        _run_cmd(["systemctl", "--user", "stop", unit_name])
        _run_cmd(["systemctl", "--user", "disable", unit_name])

        unit_file = self._unit_path(name)
        if unit_file.exists():
            try:
                unit_file.unlink()
            except OSError:
                return False

        _run_cmd(["systemctl", "--user", "daemon-reload"])
        return True

    def get_service_status(self, name: str) -> ServiceStatus:
        result = _run_cmd(["systemctl", "--user", "is-active", self._unit_name(name)])
        if result is None:
            return "not_installed"

        state = result.stdout.strip()
        if state == "active":
            return "running"
        elif state in ("inactive", "failed"):
            return "stopped"
        return "not_installed"

    def start_service(self, name: str) -> bool:
        result = _run_cmd(["systemctl", "--user", "start", self._unit_name(name)])
        return result is not None and result.returncode == 0

    def stop_service(self, name: str) -> bool:
        result = _run_cmd(["systemctl", "--user", "stop", self._unit_name(name)])
        return result is not None and result.returncode == 0

    # --- software discovery ---

    def _collect_dpkg(self) -> tuple[list[SoftwareInfo], list[str]]:
        result = _run_cmd(["dpkg-query", "-W", "-f=${Package}\t${Version}\n"])
        if result is None:
            return [], ["dpkg: command not found or failed"]
        if result.returncode != 0:
            return [], [f"dpkg: exit code {result.returncode}"]

        items: list[SoftwareInfo] = []
        for line in result.stdout.strip().splitlines():
            parts = line.split("\t", 1)
            if parts:
                name = parts[0]
                version = parts[1] if len(parts) > 1 else None
                items.append(SoftwareInfo(name=name, version=version, source="dpkg"))
        return items, []

    def _collect_snap(self) -> tuple[list[SoftwareInfo], list[str]]:
        result = _run_cmd(["snap", "list"])
        if result is None:
            return [], ["snap: command not found or failed"]

        items: list[SoftwareInfo] = []
        for line in result.stdout.strip().splitlines()[1:]:  # skip header
            parts = line.split()
            if len(parts) >= 2:
                items.append(
                    SoftwareInfo(name=parts[0], version=parts[1], source="snap")
                )
        return items, []

    def _collect_flatpak(self) -> tuple[list[SoftwareInfo], list[str]]:
        result = _run_cmd(["flatpak", "list", "--columns=application,version"])
        if result is None:
            return [], ["flatpak: command not found or failed"]

        items: list[SoftwareInfo] = []
        for line in result.stdout.strip().splitlines():
            parts = line.split("\t", 1)
            if parts:
                name = parts[0].strip()
                version = parts[1].strip() if len(parts) > 1 else None
                if name:
                    items.append(
                        SoftwareInfo(name=name, version=version, source="flatpak")
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
            self._collect_dpkg,
            self._collect_snap,
            self._collect_flatpak,
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

        # Parse mount output
        result = _run_cmd(["mount"])
        if result is None:
            errors.append("mount: command failed")
        else:
            for line in result.stdout.strip().splitlines():
                # Format: device on mountpoint type fstype (options)
                parts = line.split()
                if len(parts) >= 5 and parts[1] == "on" and parts[3] == "type":
                    device = parts[0]
                    mountpoint = parts[2]
                    fstype = parts[4]

                    if fstype in ("cifs", "nfs", "nfs4", "smbfs"):
                        items.append(
                            ShareInfo(
                                name=Path(mountpoint).name or mountpoint,
                                path=mountpoint,
                                share_type=fstype,
                                remote=device,
                            )
                        )

        # Parse /etc/fstab for persistent mounts
        try:
            fstab = Path("/etc/fstab").read_text()
            for line in fstab.strip().splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                if len(parts) >= 3 and parts[2] in ("cifs", "nfs", "nfs4"):
                    items.append(
                        ShareInfo(
                            name=Path(parts[1]).name or parts[1],
                            path=parts[1],
                            share_type=parts[2],
                            remote=parts[0],
                        )
                    )
        except (OSError, PermissionError) as exc:
            errors.append(f"fstab: {exc}")

        return DiscoveryResult[ShareInfo](
            items=items,
            complete=len(errors) == 0,
            errors=errors,
        )

    # --- scheduled tasks ---

    def list_scheduled_tasks(self) -> DiscoveryResult[TaskInfo]:
        items: list[TaskInfo] = []
        errors: list[str] = []

        result = _run_cmd(["crontab", "-l"])
        if result is None:
            errors.append("crontab: command failed")
        elif result.returncode != 0:
            # No crontab for user — not an error, just empty
            pass
        else:
            for line in result.stdout.strip().splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split(None, 5)
                if len(parts) >= 6:
                    schedule = " ".join(parts[:5])
                    command = parts[5]
                    items.append(
                        TaskInfo(
                            name=command.split()[0] if command else line,
                            schedule=schedule,
                            command=command,
                        )
                    )

        return DiscoveryResult[TaskInfo](
            items=items,
            complete=len(errors) == 0,
            errors=errors,
        )
