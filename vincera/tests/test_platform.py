"""Tests for vincera.platform — models, detection, service management, discovery."""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from vincera.platform import (
    DiscoveryResult,
    PlatformService,
    ProcessInfo,
    ShareInfo,
    SoftwareInfo,
    TaskInfo,
    get_platform_service,
    os_type,
)
from vincera.platform._base import _run_cmd


# ============================================================
# Backwards compatibility
# ============================================================


class TestBackwardsCompat:
    def test_os_type_still_importable(self) -> None:
        assert os_type in ("macos", "linux", "windows")

    def test_os_type_is_macos(self) -> None:
        assert os_type == "macos"

    def test_factory_returns_platform_service(self) -> None:
        svc = get_platform_service()
        assert isinstance(svc, PlatformService)

    def test_factory_returns_macos_on_darwin(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = get_platform_service()
        assert isinstance(svc, MacOSPlatformService)


# ============================================================
# _run_cmd helper
# ============================================================


class TestRunCmd:
    def test_successful_command(self) -> None:
        result = _run_cmd(["echo", "hello"])
        assert result is not None
        assert result.stdout.strip() == "hello"

    def test_missing_command_returns_none(self) -> None:
        result = _run_cmd(["nonexistent_binary_xyz_123"])
        assert result is None

    def test_timeout_returns_none(self) -> None:
        result = _run_cmd(["sleep", "10"], timeout=1)
        assert result is None

    def test_permission_error_returns_none(self) -> None:
        with patch("vincera.platform._base.subprocess.run", side_effect=PermissionError):
            result = _run_cmd(["anything"])
            assert result is None


# ============================================================
# DiscoveryResult model
# ============================================================


class TestDiscoveryResult:
    def test_defaults(self) -> None:
        r: DiscoveryResult[SoftwareInfo] = DiscoveryResult(items=[])
        assert r.complete is True
        assert r.errors == []
        assert r.items == []

    def test_with_items(self) -> None:
        info = SoftwareInfo(name="vim", version="9.0", source="brew")
        r = DiscoveryResult(items=[info])
        assert len(r.items) == 1
        assert r.items[0].name == "vim"

    def test_incomplete(self) -> None:
        r: DiscoveryResult[SoftwareInfo] = DiscoveryResult(
            items=[], complete=False, errors=["brew: command not found"]
        )
        assert r.complete is False
        assert "brew" in r.errors[0]


# ============================================================
# Pydantic model tests
# ============================================================


class TestModels:
    def test_software_info_defaults(self) -> None:
        s = SoftwareInfo(name="python", source="brew")
        assert s.version is None

    def test_process_info(self) -> None:
        p = ProcessInfo(pid=1, name="init")
        assert p.user is None
        assert p.cmdline == []

    def test_share_info(self) -> None:
        s = ShareInfo(name="home", path="/home", share_type="nfs")
        assert s.remote is None

    def test_task_info(self) -> None:
        t = TaskInfo(name="backup")
        assert t.schedule is None
        assert t.command is None


# ============================================================
# list_running_processes (live — cross-platform via psutil)
# ============================================================


class TestListRunningProcesses:
    def test_returns_processes(self) -> None:
        svc = get_platform_service()
        result = svc.list_running_processes()
        assert isinstance(result, DiscoveryResult)
        assert len(result.items) > 0

    def test_has_current_process(self) -> None:
        import os

        svc = get_platform_service()
        result = svc.list_running_processes()
        pids = {p.pid for p in result.items}
        assert os.getpid() in pids

    def test_process_fields(self) -> None:
        svc = get_platform_service()
        result = svc.list_running_processes()
        for p in result.items[:5]:
            assert p.pid >= 0
            assert isinstance(p.name, str)


# ============================================================
# macOS: list_installed_software
# ============================================================


class TestMacOSInstalledSoftware:
    def test_live_returns_some_results(self) -> None:
        svc = get_platform_service()
        result = svc.list_installed_software()
        assert isinstance(result, DiscoveryResult)
        assert len(result.items) > 0

    def test_brew_parsing(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        mock_output = "git 2.44.0\npython@3.11 3.11.8\nopenssl@3 3.2.1\n"
        fake_result = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=mock_output, stderr=""
        )
        with patch("vincera.platform._macos._run_cmd", return_value=fake_result):
            items, errors = svc._collect_brew()

        assert len(items) == 3
        assert items[0].name == "git"
        assert items[0].version == "2.44.0"
        assert items[0].source == "brew"
        assert items[1].name == "python@3.11"

    def test_brew_not_installed(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        with patch("vincera.platform._macos._run_cmd", return_value=None):
            items, errors = svc._collect_brew()

        assert items == []
        assert len(errors) == 1
        assert "brew" in errors[0].lower()

    def test_pip_parsing(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        mock_output = '[{"name": "requests", "version": "2.31.0"}, {"name": "flask", "version": "3.0.0"}]'
        fake_result = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=mock_output, stderr=""
        )
        with patch("vincera.platform._macos._run_cmd", return_value=fake_result):
            items, errors = svc._collect_pip()

        assert len(items) == 2
        assert items[0].name == "requests"
        assert items[0].source == "pip"

    def test_npm_parsing(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        mock_output = '{"dependencies": {"typescript": {"version": "5.3.3"}, "eslint": {"version": "8.56.0"}}}'
        fake_result = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=mock_output, stderr=""
        )
        with patch("vincera.platform._macos._run_cmd", return_value=fake_result):
            items, errors = svc._collect_npm()

        assert len(items) == 2
        names = {i.name for i in items}
        assert "typescript" in names
        assert items[0].source == "npm"

    def test_completeness_flag_on_partial_failure(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        # Brew fails but pip works
        with patch.object(svc, "_collect_brew", return_value=([], ["brew: failed"])):
            with patch.object(
                svc,
                "_collect_pip",
                return_value=([SoftwareInfo(name="x", source="pip")], []),
            ):
                with patch.object(svc, "_collect_npm", return_value=([], [])):
                    with patch.object(svc, "_collect_applications", return_value=([], [])):
                        result = svc.list_installed_software()

        assert result.complete is False
        assert len(result.items) == 1
        assert "brew" in result.errors[0].lower()


# ============================================================
# macOS: list_network_shares
# ============================================================


class TestMacOSNetworkShares:
    def test_live_returns_result(self) -> None:
        svc = get_platform_service()
        result = svc.list_network_shares()
        assert isinstance(result, DiscoveryResult)

    def test_mount_parsing(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        mock_output = (
            "/dev/disk1s1 on / (apfs, local, journaled)\n"
            "nas.local:/share on /Volumes/NAS (nfs)\n"
            "//user@server/share on /Volumes/Share (smbfs, nodev)\n"
        )
        fake_result = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=mock_output, stderr=""
        )
        with patch("vincera.platform._macos._run_cmd", return_value=fake_result):
            result = svc.list_network_shares()

        # Should pick up nfs and smbfs entries
        remote_shares = [s for s in result.items if s.share_type in ("nfs", "smbfs")]
        assert len(remote_shares) == 2


# ============================================================
# macOS: list_scheduled_tasks
# ============================================================


class TestMacOSScheduledTasks:
    def test_live_returns_result(self) -> None:
        svc = get_platform_service()
        result = svc.list_scheduled_tasks()
        assert isinstance(result, DiscoveryResult)

    def test_launchctl_parsing(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        mock_output = (
            "PID\tStatus\tLabel\n"
            "123\t0\tcom.apple.something\n"
            "-\t0\tcom.example.task\n"
            "456\t-1\tcom.vincera.agent\n"
        )
        fake_result = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=mock_output, stderr=""
        )
        with patch("vincera.platform._macos._run_cmd", return_value=fake_result):
            result = svc.list_scheduled_tasks()

        assert len(result.items) == 3
        names = {t.name for t in result.items}
        assert "com.apple.something" in names
        assert "com.vincera.agent" in names

        vincera = next(t for t in result.items if t.name == "com.vincera.agent")
        assert vincera.status == "running"


# ============================================================
# macOS: service management
# ============================================================


class TestMacOSServiceManagement:
    def test_install_writes_plist(self, tmp_path: Path) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        plist_dir = tmp_path / "LaunchAgents"
        plist_dir.mkdir()

        with patch.object(svc, "_launch_agents_dir", return_value=plist_dir):
            with patch("vincera.platform._macos._run_cmd") as mock_run:
                mock_run.return_value = subprocess.CompletedProcess(
                    args=[], returncode=0, stdout="", stderr=""
                )
                result = svc.install_service(
                    "test-agent",
                    "/usr/bin/python3 -m vincera.agent",
                    "Test Agent",
                )

        assert result is True
        plist_file = plist_dir / "com.vincera.test-agent.plist"
        assert plist_file.exists()
        content = plist_file.read_text()
        assert "com.vincera.test-agent" in content
        assert "/usr/bin/python3" in content

    def test_uninstall_removes_plist(self, tmp_path: Path) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        plist_dir = tmp_path / "LaunchAgents"
        plist_dir.mkdir()
        plist_file = plist_dir / "com.vincera.test-agent.plist"
        plist_file.write_text("<plist></plist>")

        with patch.object(svc, "_launch_agents_dir", return_value=plist_dir):
            with patch("vincera.platform._macos._run_cmd") as mock_run:
                mock_run.return_value = subprocess.CompletedProcess(
                    args=[], returncode=0, stdout="", stderr=""
                )
                result = svc.uninstall_service("test-agent")

        assert result is True
        assert not plist_file.exists()

    def test_get_service_status_running(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        mock_output = "PID\tStatus\tLabel\n123\t0\tcom.vincera.myagent\n"
        fake_result = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=mock_output, stderr=""
        )
        with patch("vincera.platform._macos._run_cmd", return_value=fake_result):
            status = svc.get_service_status("myagent")
        assert status == "running"

    def test_get_service_status_stopped(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        mock_output = "PID\tStatus\tLabel\n-\t0\tcom.vincera.myagent\n"
        fake_result = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=mock_output, stderr=""
        )
        with patch("vincera.platform._macos._run_cmd", return_value=fake_result):
            status = svc.get_service_status("myagent")
        assert status == "stopped"

    def test_get_service_status_not_installed(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        mock_output = "PID\tStatus\tLabel\n123\t0\tcom.apple.something\n"
        fake_result = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=mock_output, stderr=""
        )
        with patch("vincera.platform._macos._run_cmd", return_value=fake_result):
            status = svc.get_service_status("myagent")
        assert status == "not_installed"

    def test_start_service(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        with patch("vincera.platform._macos._run_cmd") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess(
                args=[], returncode=0, stdout="", stderr=""
            )
            result = svc.start_service("myagent")
        assert result is True
        mock_run.assert_called_once()

    def test_stop_service(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        with patch("vincera.platform._macos._run_cmd") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess(
                args=[], returncode=0, stdout="", stderr=""
            )
            result = svc.stop_service("myagent")
        assert result is True


# ============================================================
# Error handling / graceful degradation
# ============================================================


class TestErrorHandling:
    def test_all_sources_fail_still_returns(self) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        with patch.object(svc, "_collect_brew", return_value=([], ["err1"])):
            with patch.object(svc, "_collect_applications", return_value=([], ["err2"])):
                with patch.object(svc, "_collect_pip", return_value=([], ["err3"])):
                    with patch.object(svc, "_collect_npm", return_value=([], ["err4"])):
                        result = svc.list_installed_software()

        assert result.complete is False
        assert len(result.errors) == 4
        assert result.items == []

    def test_service_install_handles_launchctl_failure(self, tmp_path: Path) -> None:
        from vincera.platform._macos import MacOSPlatformService

        svc = MacOSPlatformService()
        plist_dir = tmp_path / "LaunchAgents"
        plist_dir.mkdir()

        with patch.object(svc, "_launch_agents_dir", return_value=plist_dir):
            with patch("vincera.platform._macos._run_cmd", return_value=None):
                result = svc.install_service("fail", "cmd", "desc")

        assert result is False
