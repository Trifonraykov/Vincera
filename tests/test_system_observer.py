"""Tests for vincera.core.system_observer — the Orchestrator's direct eyes."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from vincera.core.system_observer import (
    ObserverConfig,
    SystemDiff,
    SystemObserver,
    SystemSnapshot,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        return loop.run_until_complete(coro)
    return asyncio.run(coro)


def _mock_scanner():
    """Return a mocked SystemScanner."""
    s = MagicMock()
    proc_result = MagicMock()
    proc_result.data = [
        {"name": "postgres", "pid": 100, "cpu_percent": 2.5, "memory_percent": 5.0, "category": "database"},
        {"name": "nginx", "pid": 200, "cpu_percent": 0.5, "memory_percent": 1.0, "category": "web_server"},
        {"name": "python3", "pid": 300, "cpu_percent": 10.0, "memory_percent": 3.0, "category": None},
    ]
    s.scan_running_processes = AsyncMock(return_value=proc_result)

    task_result = MagicMock()
    task_result.data = [
        {"name": "backup-cron", "schedule": "0 2 * * *", "command": "/usr/bin/backup.sh"},
    ]
    s.scan_scheduled_tasks = AsyncMock(return_value=task_result)
    return s


def _mock_filesystem():
    """Return a mocked FilesystemMapper."""
    fs = MagicMock()
    # Return an empty tree by default
    tree = MagicMock()
    tree.children = []
    fs.map_directory = AsyncMock(return_value=tree)
    return fs


def _mock_database():
    """Return a mocked DatabaseDiscovery."""
    db = MagicMock()
    db.discover_databases = AsyncMock(return_value=[])
    db.extract_schema = AsyncMock(return_value=None)
    return db


def _mock_network():
    """Return a mocked NetworkDiscovery."""
    net = MagicMock()
    net.discover_shares = AsyncMock(return_value=[])
    return net


def _mock_platform():
    """Return a mocked PlatformService."""
    return MagicMock()


def _build_observer(**overrides):
    """Build a SystemObserver with mocked dependencies."""
    config = overrides.pop("config", ObserverConfig())
    return SystemObserver(
        scanner=overrides.get("scanner", _mock_scanner()),
        filesystem=overrides.get("filesystem", _mock_filesystem()),
        database=overrides.get("database", _mock_database()),
        network=overrides.get("network", _mock_network()),
        platform_service=overrides.get("platform_service", _mock_platform()),
        config=config,
    )


def _snapshot(**overrides) -> SystemSnapshot:
    """Build a minimal SystemSnapshot with overrides."""
    defaults = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "cpu_percent": 20.0,
        "memory_used_percent": 50.0,
        "memory_available_gb": 8.0,
        "disk_usage": [{"mountpoint": "/", "total_gb": 500, "used_gb": 200, "free_gb": 300, "percent": 40}],
        "processes": [
            {"name": "postgres", "pid": 100, "cpu_percent": 2.5},
            {"name": "nginx", "pid": 200, "cpu_percent": 0.5},
        ],
        "process_count": 2,
        "scheduled_tasks": [{"name": "backup-cron"}],
        "watched_file_changes": [],
        "databases": [],
        "database_schemas": [],
        "network_shares": [],
        "recent_log_entries": [],
    }
    defaults.update(overrides)
    return SystemSnapshot(**defaults)


# ---------------------------------------------------------------------------
# TestSnapshot — take_snapshot()
# ---------------------------------------------------------------------------

class TestSnapshot:
    def test_take_snapshot_returns_complete(self):
        obs = _build_observer()
        with patch("vincera.core.system_observer.psutil") as mock_psutil:
            mock_psutil.cpu_percent.return_value = 25.0
            mock_mem = MagicMock()
            mock_mem.percent = 60.0
            mock_mem.available = 8 * (1024**3)
            mock_psutil.virtual_memory.return_value = mock_mem
            mock_psutil.disk_partitions.return_value = []

            snap = _run(obs.take_snapshot())

        assert isinstance(snap, SystemSnapshot)
        assert snap.cpu_percent == 25.0
        assert snap.memory_used_percent == 60.0
        assert snap.process_count == 3
        assert len(snap.processes) == 3
        assert len(snap.scheduled_tasks) == 1
        assert snap.scan_duration_ms >= 0
        assert snap.timestamp

    def test_take_snapshot_partial_failure(self):
        """If one subsystem fails, others still populate."""
        scanner = _mock_scanner()
        scanner.scan_running_processes = AsyncMock(side_effect=RuntimeError("ps failed"))

        obs = _build_observer(scanner=scanner)
        with patch("vincera.core.system_observer.psutil") as mock_psutil:
            mock_psutil.cpu_percent.return_value = 10.0
            mock_mem = MagicMock()
            mock_mem.percent = 40.0
            mock_mem.available = 4 * (1024**3)
            mock_psutil.virtual_memory.return_value = mock_mem
            mock_psutil.disk_partitions.return_value = []

            snap = _run(obs.take_snapshot())

        # Processes failed, but rest is fine
        assert snap.process_count == 0
        assert len(snap.errors) >= 1
        assert "processes" in snap.errors[0]
        # Tasks should still work
        assert len(snap.scheduled_tasks) == 1

    def test_take_snapshot_timing(self):
        obs = _build_observer()
        with patch("vincera.core.system_observer.psutil") as mock_psutil:
            mock_psutil.cpu_percent.return_value = 5.0
            mock_mem = MagicMock()
            mock_mem.percent = 30.0
            mock_mem.available = 12 * (1024**3)
            mock_psutil.virtual_memory.return_value = mock_mem
            mock_psutil.disk_partitions.return_value = []

            snap = _run(obs.take_snapshot())

        assert snap.scan_duration_ms >= 0

    def test_snapshot_stores_as_last(self):
        obs = _build_observer()
        assert obs.last_snapshot is None

        with patch("vincera.core.system_observer.psutil") as mock_psutil:
            mock_psutil.cpu_percent.return_value = 5.0
            mock_mem = MagicMock()
            mock_mem.percent = 30.0
            mock_mem.available = 12 * (1024**3)
            mock_psutil.virtual_memory.return_value = mock_mem
            mock_psutil.disk_partitions.return_value = []

            snap = _run(obs.take_snapshot())

        assert obs.last_snapshot is snap


# ---------------------------------------------------------------------------
# TestDiff — diff()
# ---------------------------------------------------------------------------

class TestDiff:
    def test_first_cycle_empty_diff(self):
        obs = _build_observer()
        new = _snapshot()
        d = obs.diff(None, new)
        assert d.total_changes == 0
        assert d.severity == "normal"

    def test_detects_new_process(self):
        obs = _build_observer()
        old = _snapshot(processes=[
            {"name": "postgres", "pid": 100},
        ], process_count=1)
        new = _snapshot(processes=[
            {"name": "postgres", "pid": 100},
            {"name": "redis", "pid": 400},
        ], process_count=2)

        d = obs.diff(old, new)
        assert len(d.new_processes) == 1
        assert d.new_processes[0]["name"] == "redis"
        assert d.total_changes >= 1
        assert d.severity == "notable"

    def test_detects_stopped_process(self):
        obs = _build_observer()
        old = _snapshot(processes=[
            {"name": "postgres", "pid": 100},
            {"name": "nginx", "pid": 200},
        ], process_count=2)
        new = _snapshot(processes=[
            {"name": "postgres", "pid": 100},
        ], process_count=1)

        d = obs.diff(old, new)
        assert len(d.stopped_processes) == 1
        assert d.stopped_processes[0]["name"] == "nginx"

    def test_detects_cpu_change(self):
        obs = _build_observer()
        old = _snapshot(cpu_percent=20.0)
        new = _snapshot(cpu_percent=80.0)
        d = obs.diff(old, new)
        assert d.cpu_change == 60.0

    def test_detects_memory_change(self):
        obs = _build_observer()
        old = _snapshot(memory_used_percent=40.0)
        new = _snapshot(memory_used_percent=75.0)
        d = obs.diff(old, new)
        assert d.memory_change == 35.0

    def test_detects_file_changes(self):
        obs = _build_observer()
        old = _snapshot(watched_file_changes=[
            {"path": "/data/report.csv", "name": "report.csv", "last_modified": "2024-01-01T00:00:00"},
        ])
        new = _snapshot(watched_file_changes=[
            {"path": "/data/report.csv", "name": "report.csv", "last_modified": "2024-01-02T00:00:00"},
            {"path": "/data/new_file.txt", "name": "new_file.txt", "last_modified": "2024-01-02T00:00:00"},
        ])

        d = obs.diff(old, new)
        assert len(d.modified_files) == 1
        assert d.modified_files[0]["name"] == "report.csv"
        assert len(d.new_files) == 1
        assert d.new_files[0]["name"] == "new_file.txt"

    def test_detects_deleted_file(self):
        obs = _build_observer()
        old = _snapshot(watched_file_changes=[
            {"path": "/data/old.csv", "name": "old.csv", "last_modified": "2024-01-01T00:00:00"},
        ])
        new = _snapshot(watched_file_changes=[])
        d = obs.diff(old, new)
        assert len(d.deleted_files) == 1

    def test_detects_new_database(self):
        obs = _build_observer()
        old = _snapshot(databases=[])
        new = _snapshot(databases=[
            {"name": "mydb", "db_type": "postgresql"},
        ])
        d = obs.diff(old, new)
        assert len(d.new_databases) == 1
        assert d.new_databases[0]["name"] == "mydb"

    def test_detects_removed_database(self):
        obs = _build_observer()
        old = _snapshot(databases=[{"name": "mydb", "db_type": "postgresql"}])
        new = _snapshot(databases=[])
        d = obs.diff(old, new)
        assert len(d.removed_databases) == 1

    def test_detects_log_anomalies(self):
        obs = _build_observer()
        old = _snapshot()
        new = _snapshot(recent_log_entries=[
            {"source": "/var/log/app.log", "line": "INFO: all good"},
            {"source": "/var/log/app.log", "line": "ERROR: connection refused"},
            {"source": "/var/log/app.log", "line": "WARNING: disk space low"},
        ])
        d = obs.diff(old, new)
        assert len(d.log_anomalies) == 2  # ERROR + WARNING

    def test_severity_normal(self):
        obs = _build_observer()
        old = _snapshot()
        new = _snapshot()
        d = obs.diff(old, new)
        assert d.severity == "normal"
        assert d.total_changes == 0

    def test_severity_notable(self):
        obs = _build_observer()
        old = _snapshot(processes=[])
        new = _snapshot(processes=[{"name": "new_svc", "pid": 999}], process_count=1)
        d = obs.diff(old, new)
        assert d.severity == "notable"

    def test_severity_alert_log_errors(self):
        obs = _build_observer()
        old = _snapshot()
        new = _snapshot(recent_log_entries=[
            {"source": "/var/log/app.log", "line": "CRITICAL: database down"},
        ])
        d = obs.diff(old, new)
        assert d.severity == "alert"

    def test_severity_alert_disk_critical(self):
        obs = _build_observer()
        old = _snapshot()
        new = _snapshot(disk_usage=[
            {"mountpoint": "/", "total_gb": 500, "used_gb": 480, "free_gb": 20, "percent": 96},
        ])
        d = obs.diff(old, new)
        assert d.severity == "alert"

    def test_detects_new_scheduled_task(self):
        obs = _build_observer()
        old = _snapshot(scheduled_tasks=[{"name": "backup-cron"}])
        new = _snapshot(scheduled_tasks=[{"name": "backup-cron"}, {"name": "cleanup-cron"}])
        d = obs.diff(old, new)
        assert len(d.new_scheduled_tasks) == 1
        assert d.new_scheduled_tasks[0]["name"] == "cleanup-cron"

    def test_detects_schema_change(self):
        obs = _build_observer()
        old = _snapshot(database_schemas=[
            {"database_name": "mydb", "tables": [{"name": "users"}, {"name": "orders"}]},
        ])
        new = _snapshot(database_schemas=[
            {"database_name": "mydb", "tables": [{"name": "users"}, {"name": "orders"}, {"name": "products"}]},
        ])
        d = obs.diff(old, new)
        assert len(d.schema_changes) == 1
        assert d.schema_changes[0]["old"] == 2
        assert d.schema_changes[0]["new"] == 3


# ---------------------------------------------------------------------------
# TestLogScanning
# ---------------------------------------------------------------------------

class TestLogScanning:
    def test_scan_logs_reads_tail(self, tmp_path):
        log_file = tmp_path / "app.log"
        log_file.write_text(
            "INFO: started\n"
            "ERROR: something broke\n"
            "DEBUG: verbose\n"
            "WARNING: watch out\n"
        )
        obs = _build_observer(config=ObserverConfig(log_paths=[str(log_file)]))
        entries = _run(obs.scan_logs([str(log_file)], lookback_lines=100))
        assert len(entries) == 4
        assert entries[1]["line"] == "ERROR: something broke"

    def test_scan_logs_missing_file(self):
        obs = _build_observer()
        entries = _run(obs.scan_logs(["/nonexistent/path.log"]))
        assert entries == []


# ---------------------------------------------------------------------------
# TestShellCommand
# ---------------------------------------------------------------------------

class TestShellCommand:
    def test_success(self):
        obs = _build_observer()
        with patch("vincera.core.system_observer._run_cmd") as mock_cmd:
            mock_result = MagicMock()
            mock_result.stdout = "output"
            mock_result.stderr = ""
            mock_result.returncode = 0
            mock_cmd.return_value = mock_result

            result = _run(obs.run_shell_command(["echo", "hello"]))

        assert result["success"] is True
        assert result["stdout"] == "output"

    def test_failure(self):
        obs = _build_observer()
        with patch("vincera.core.system_observer._run_cmd") as mock_cmd:
            mock_cmd.return_value = None

            result = _run(obs.run_shell_command(["bad_command"]))

        assert result["success"] is False
        assert result["returncode"] == -1

    def test_truncates_output(self):
        obs = _build_observer()
        with patch("vincera.core.system_observer._run_cmd") as mock_cmd:
            mock_result = MagicMock()
            mock_result.stdout = "x" * 20_000
            mock_result.stderr = "y" * 10_000
            mock_result.returncode = 0
            mock_cmd.return_value = mock_result

            result = _run(obs.run_shell_command(["bigcmd"]))

        assert len(result["stdout"]) == 10_000
        assert len(result["stderr"]) == 5_000


# ---------------------------------------------------------------------------
# TestObserverConfig
# ---------------------------------------------------------------------------

class TestObserverConfig:
    def test_default_config(self):
        c = ObserverConfig()
        assert c.scan_databases is True
        assert c.scan_network is True
        assert c.scan_files is True
        assert c.scan_logs is True
        assert c.file_change_lookback_seconds == 120
        assert c.log_lookback_lines == 100

    def test_custom_config(self):
        c = ObserverConfig(
            watched_directories=["/data"],
            log_paths=["/var/log/app.log"],
            scan_databases=False,
        )
        assert c.watched_directories == ["/data"]
        assert c.scan_databases is False
