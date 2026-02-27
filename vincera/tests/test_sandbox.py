"""Tests for vincera.execution.sandbox — DockerSandbox."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from vincera.execution.sandbox import DockerSandbox, SandboxResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _mock_process(returncode: int = 0, stdout: bytes = b"", stderr: bytes = b""):
    """Return a mock async subprocess."""
    proc = MagicMock()
    proc.returncode = returncode
    proc.communicate = AsyncMock(return_value=(stdout, stderr))
    proc.wait = AsyncMock()
    proc.kill = MagicMock()
    return proc


def _mock_config(tmp_path: Path):
    config = MagicMock()
    deploy_dir = tmp_path / "VinceraHQ" / "deployments"
    deploy_dir.mkdir(parents=True, exist_ok=True)
    config.home_dir = tmp_path / "VinceraHQ"
    return config


def _make_sandbox(tmp_path: Path, docker_available: bool = False) -> DockerSandbox:
    config = _mock_config(tmp_path)
    sb = DockerSandbox(config=config)
    sb._docker_available = docker_available
    return sb


# ===========================================================================
# initialize
# ===========================================================================

class TestInitialize:
    def test_docker_available(self, tmp_path: Path) -> None:
        config = _mock_config(tmp_path)
        sb = DockerSandbox(config=config)
        proc = _mock_process(returncode=0)
        with patch("vincera.execution.sandbox.asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            _run(sb.initialize())
        assert sb.docker_available is True

    def test_docker_unavailable(self, tmp_path: Path) -> None:
        config = _mock_config(tmp_path)
        sb = DockerSandbox(config=config)
        with patch("vincera.execution.sandbox.asyncio.create_subprocess_exec", AsyncMock(side_effect=FileNotFoundError)):
            _run(sb.initialize())
        assert sb.docker_available is False


# ===========================================================================
# execute_python
# ===========================================================================

class TestExecutePython:
    def test_docker_path(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path, docker_available=True)
        proc = _mock_process(returncode=0, stdout=b"hello\n")
        with patch("vincera.execution.sandbox.asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            result = _run(sb.execute_python("print('hello')"))
        assert result.success is True
        assert result.sandbox_type == "docker"

    def test_subprocess_fallback(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path, docker_available=False)
        proc = _mock_process(returncode=0, stdout=b"ok\n")
        with patch("vincera.execution.sandbox.asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            result = _run(sb.execute_python("print('ok')"))
        assert result.success is True
        assert result.sandbox_type == "subprocess"

    def test_timeout(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path, docker_available=False)
        proc = _mock_process()
        proc.communicate = AsyncMock(side_effect=asyncio.TimeoutError)
        with patch("vincera.execution.sandbox.asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            result = _run(sb.execute_python("import time; time.sleep(999)", timeout=1))
        assert result.success is False
        assert "timed out" in result.stderr.lower()

    def test_failure(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path, docker_available=False)
        proc = _mock_process(returncode=1, stderr=b"NameError: x\n")
        with patch("vincera.execution.sandbox.asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            result = _run(sb.execute_python("print(x)"))
        assert result.success is False
        assert result.exit_code == 1

    def test_stdout_captured(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path, docker_available=False)
        proc = _mock_process(returncode=0, stdout=b"line1\nline2\n")
        with patch("vincera.execution.sandbox.asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            result = _run(sb.execute_python("print('line1'); print('line2')"))
        assert "line1" in result.stdout
        assert "line2" in result.stdout

    def test_stderr_captured(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path, docker_available=False)
        proc = _mock_process(returncode=1, stderr=b"error detail\n")
        with patch("vincera.execution.sandbox.asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            result = _run(sb.execute_python("bad"))
        assert "error detail" in result.stderr

    def test_output_truncated(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path, docker_available=False)
        long_output = b"x" * 20000
        proc = _mock_process(returncode=0, stdout=long_output)
        with patch("vincera.execution.sandbox.asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            result = _run(sb.execute_python("print('x' * 20000)"))
        assert len(result.stdout) <= 10000

    def test_script_cleanup(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path, docker_available=False)
        proc = _mock_process(returncode=0)
        with patch("vincera.execution.sandbox.asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            _run(sb.execute_python("print(1)"))
        # After execution, no sandbox_*.py files should remain
        remaining = list(sb._deployments_dir.glob("sandbox_*.py"))
        assert len(remaining) == 0


# ===========================================================================
# validate_script_safety
# ===========================================================================

class TestValidateScriptSafety:
    def test_safe_script(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path)
        safe, violations = _run(sb.validate_script_safety("print('hello world')"))
        assert safe is True
        assert violations == []

    def test_os_system(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path)
        safe, violations = _run(sb.validate_script_safety("os.system('rm -rf /')"))
        assert safe is False
        assert len(violations) > 0

    def test_subprocess(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path)
        safe, violations = _run(sb.validate_script_safety("subprocess.run(['ls'])"))
        assert safe is False

    def test_eval(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path)
        safe, violations = _run(sb.validate_script_safety("eval('1+1')"))
        assert safe is False

    def test_network(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path)
        safe, violations = _run(sb.validate_script_safety("socket.connect(('host', 80))"))
        assert safe is False

    def test_file_write(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path)
        safe, violations = _run(sb.validate_script_safety("f = open('out.txt', 'w')"))
        assert safe is False
        assert any("write" in v.lower() for v in violations)

    def test_file_read_ok(self, tmp_path: Path) -> None:
        sb = _make_sandbox(tmp_path)
        safe, violations = _run(sb.validate_script_safety("f = open('data.csv', 'r')"))
        # Read-only open should not trigger a violation
        assert safe is True
