"""Docker Sandbox — isolated execution for untrusted automation scripts."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.config import VinceraSettings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class SandboxResult(BaseModel):
    """Result of a sandboxed script execution."""

    success: bool
    exit_code: int
    stdout: str
    stderr: str
    execution_time_seconds: float
    sandbox_type: str  # "docker" or "subprocess"
    resource_usage: dict = {}


# ---------------------------------------------------------------------------
# Sandbox
# ---------------------------------------------------------------------------

class DockerSandbox:
    """Provides isolated execution via Docker (preferred) or subprocess fallback."""

    def __init__(self, config: VinceraSettings) -> None:
        self._config = config
        self._docker_available: bool = False
        self._deployments_dir = config.home_dir / "deployments"
        self._deployments_dir.mkdir(parents=True, exist_ok=True)

    @property
    def docker_available(self) -> bool:
        return self._docker_available

    async def initialize(self) -> None:
        """Check if Docker is available."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "info",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.wait()
            self._docker_available = proc.returncode == 0
        except FileNotFoundError:
            self._docker_available = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def execute_python(
        self,
        script: str,
        timeout: int = 30,
        env_vars: dict | None = None,
    ) -> SandboxResult:
        if self._docker_available:
            return await self._execute_docker(script, timeout, env_vars)
        return await self._execute_subprocess(script, timeout, env_vars)

    async def validate_script_safety(self, script: str) -> tuple[bool, list[str]]:
        """Static analysis for dangerous patterns."""
        violations: list[str] = []

        DANGEROUS_PATTERNS = {
            "os.system": "Direct system command execution",
            "subprocess.call": "Subprocess execution",
            "subprocess.run": "Subprocess execution",
            "subprocess.Popen": "Subprocess execution",
            "shutil.rmtree": "Recursive directory deletion",
            "os.remove": "File deletion",
            "os.unlink": "File deletion",
            "os.rmdir": "Directory deletion",
            "__import__": "Dynamic import",
            "eval(": "Dynamic code evaluation",
            "exec(": "Dynamic code execution",
            "socket.": "Network socket access",
            "requests.": "HTTP requests (network access)",
            "urllib.": "URL access (network access)",
            "smtplib.": "Email sending",
            "ftplib.": "FTP access",
        }

        for pattern, reason in DANGEROUS_PATTERNS.items():
            if pattern in script:
                violations.append(f"Found '{pattern}': {reason}")

        # Check for file writes specifically
        if "open(" in script:
            write_opens = re.findall(r'open\([^)]*["\']([wax+])["\']', script)
            if write_opens:
                violations.append("File write operations detected")

        return (len(violations) == 0, violations)

    # ------------------------------------------------------------------
    # Docker execution
    # ------------------------------------------------------------------

    async def _execute_docker(
        self,
        script: str,
        timeout: int,
        env_vars: dict | None,
    ) -> SandboxResult:
        script_path = self._deployments_dir / f"sandbox_{int(time.time())}.py"
        script_path.write_text(script)

        try:
            cmd = [
                "docker", "run", "--rm",
                "--network=none",
                "--memory=256m",
                "--cpus=0.5",
                "--read-only",
                "--tmpfs", "/tmp:size=64m",
                "-v", f"{script_path}:/script.py:ro",
            ]

            if env_vars:
                for k, v in env_vars.items():
                    cmd.extend(["-e", f"{k}={v}"])

            cmd.extend(["python:3.11-slim", "python", "/script.py"])

            start = time.monotonic()
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=timeout,
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                return SandboxResult(
                    success=False, exit_code=-1,
                    stdout="", stderr="Execution timed out",
                    execution_time_seconds=timeout,
                    sandbox_type="docker",
                )

            elapsed = time.monotonic() - start
            return SandboxResult(
                success=proc.returncode == 0,
                exit_code=proc.returncode or 0,
                stdout=stdout.decode("utf-8", errors="replace")[:10000],
                stderr=stderr.decode("utf-8", errors="replace")[:10000],
                execution_time_seconds=round(elapsed, 2),
                sandbox_type="docker",
            )
        finally:
            script_path.unlink(missing_ok=True)

    # ------------------------------------------------------------------
    # Subprocess fallback
    # ------------------------------------------------------------------

    async def _execute_subprocess(
        self,
        script: str,
        timeout: int,
        env_vars: dict | None,
    ) -> SandboxResult:
        script_path = self._deployments_dir / f"sandbox_{int(time.time())}.py"
        script_path.write_text(script)

        try:
            env = os.environ.copy()
            if env_vars:
                env.update(env_vars)

            start = time.monotonic()
            proc = await asyncio.create_subprocess_exec(
                "python3", str(script_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )

            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=timeout,
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                return SandboxResult(
                    success=False, exit_code=-1,
                    stdout="", stderr="Execution timed out",
                    execution_time_seconds=timeout,
                    sandbox_type="subprocess",
                )

            elapsed = time.monotonic() - start
            return SandboxResult(
                success=proc.returncode == 0,
                exit_code=proc.returncode or 0,
                stdout=stdout.decode("utf-8", errors="replace")[:10000],
                stderr=stderr.decode("utf-8", errors="replace")[:10000],
                execution_time_seconds=round(elapsed, 2),
                sandbox_type="subprocess",
            )
        finally:
            script_path.unlink(missing_ok=True)
