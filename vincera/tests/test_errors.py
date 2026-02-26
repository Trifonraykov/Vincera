"""Tests for Stage 29 — exception hierarchy, agent error handling,
circuit breaker, secret redaction, resource monitoring, and security audit.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from vincera.utils.errors import (
    AuthorityError,
    ConfigError,
    DeploymentError,
    DiscoveryError,
    GhostModeError,
    LLMCircuitOpenError,
    LLMError,
    ResearchError,
    ResourceError,
    SandboxError,
    SupabaseError,
    VerificationError,
    VinceraError,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    """Run an async coroutine synchronously."""
    return asyncio.run(coro)


# ===========================================================================
# Test 1: Exception hierarchy
# ===========================================================================

class TestExceptionHierarchy:
    def test_all_exceptions_inherit_from_vincera_error(self):
        """All custom exceptions are subclasses of VinceraError."""
        for exc_class in [
            ConfigError, LLMError, LLMCircuitOpenError, DiscoveryError,
            ResearchError, VerificationError, SandboxError,
            DeploymentError, SupabaseError, GhostModeError,
            AuthorityError, ResourceError,
        ]:
            assert issubclass(exc_class, VinceraError), f"{exc_class.__name__} does not inherit from VinceraError"

    def test_llm_circuit_open_inherits_from_llm_error(self):
        """LLMCircuitOpenError is a subclass of LLMError."""
        assert issubclass(LLMCircuitOpenError, LLMError)

    def test_vincera_error_carries_context(self):
        """VinceraError stores agent_name and context."""
        err = VinceraError("test", agent_name="builder", context={"key": "value"})
        assert err.agent_name == "builder"
        assert err.context == {"key": "value"}
        assert str(err) == "test"

    def test_vincera_error_defaults(self):
        """VinceraError defaults: agent_name=None, context={}."""
        err = VinceraError("test")
        assert err.agent_name is None
        assert err.context == {}

    def test_all_importable_from_utils(self):
        """All exceptions importable from vincera.utils."""
        from vincera.utils import (
            VinceraError, ConfigError, LLMError, LLMCircuitOpenError,
            DiscoveryError, ResearchError, VerificationError, SandboxError,
            DeploymentError, SupabaseError, GhostModeError, AuthorityError,
            ResourceError,
        )
        assert VinceraError is not None


# ===========================================================================
# Test 2: Agent error handling
# ===========================================================================

class TestAgentErrorHandling:
    def _make_agent(self, tmp_path: Path, run_side_effect=None):
        """Create a concrete agent subclass for testing."""
        from vincera.agents.base import BaseAgent

        sb = MagicMock()
        sb.send_message.return_value = {"id": "msg-1"}
        sb.log_event.return_value = {"id": "ev-1"}
        sb.query_knowledge.return_value = []

        state = MagicMock()
        state.update_agent_status = MagicMock()
        state.get_agent_status.return_value = {"status": "idle"}
        state._db = MagicMock()
        state._db.query.return_value = []

        config = MagicMock()
        config.home_dir = tmp_path / "VinceraHQ"
        config.home_dir.mkdir(parents=True, exist_ok=True)
        (config.home_dir / "agents").mkdir(parents=True, exist_ok=True)
        config.company_name = "TestCorp"

        llm = MagicMock()
        llm.think = AsyncMock(return_value="ok")
        verifier = MagicMock()

        class TestAgent(BaseAgent):
            async def run(self, task):
                if run_side_effect:
                    raise run_side_effect
                return {"result": "done"}

        agent = TestAgent(
            name="test_agent",
            company_id="comp-1",
            config=config,
            llm=llm,
            supabase=sb,
            state=state,
            verifier=verifier,
        )
        return agent, sb, state

    def test_vincera_error_sets_failed_and_reports(self, tmp_path: Path):
        """When run() raises VinceraError, status=FAILED, alert sent, event logged."""
        error = DiscoveryError("scan failed", agent_name="test_agent", context={"path": "/etc"})
        agent, sb, state = self._make_agent(tmp_path, run_side_effect=error)

        with pytest.raises(DiscoveryError):
            _run(agent.execute({"type": "scan"}))

        assert agent.status.value == "failed"
        # Alert message sent
        sb.send_message.assert_called()
        alert_call = sb.send_message.call_args
        assert alert_call[0][3] == "alert"  # message_type
        # Event logged
        sb.log_event.assert_called()

    def test_unknown_exception_wrapped(self, tmp_path: Path):
        """When run() raises a non-VinceraError, it's wrapped in VinceraError."""
        agent, sb, state = self._make_agent(tmp_path, run_side_effect=RuntimeError("boom"))

        with pytest.raises(VinceraError) as exc_info:
            _run(agent.execute({"type": "task"}))

        assert "Unexpected error" in str(exc_info.value)
        assert exc_info.value.context["original_type"] == "RuntimeError"
        assert agent.status.value == "failed"

    def test_error_report_failure_doesnt_cascade(self, tmp_path: Path):
        """If error reporting itself fails, the original error still propagates."""
        error = LLMError("api down")
        agent, sb, state = self._make_agent(tmp_path, run_side_effect=error)

        # Make error reporting fail
        sb.send_message.side_effect = Exception("Supabase down")
        sb.log_event.side_effect = Exception("Supabase down")

        with pytest.raises(LLMError):
            _run(agent.execute({"type": "think"}))

        # Agent still ends up in failed state
        assert agent.status.value == "failed"

    def test_handle_message_error_returns_response(self, tmp_path: Path):
        """handle_message() catches errors and returns error response."""
        agent, sb, state = self._make_agent(tmp_path)
        agent._llm.think = AsyncMock(side_effect=RuntimeError("LLM crashed"))

        response = _run(agent.handle_message("hello"))

        assert "error" in response.lower()
        assert "RuntimeError" in response

    def test_successful_run(self, tmp_path: Path):
        """Successful run() sets COMPLETED."""
        agent, sb, state = self._make_agent(tmp_path)

        result = _run(agent.execute({"type": "scan"}))

        assert result == {"result": "done"}
        assert agent.status.value == "completed"


# ===========================================================================
# Test 3: Circuit breaker
# ===========================================================================

class TestCircuitBreaker:
    def test_opens_after_threshold(self):
        """Circuit breaker opens after 5 consecutive failures."""
        from vincera.core.llm import OpenRouterClient

        client = MagicMock(spec=OpenRouterClient)
        client._consecutive_failures = 0
        client._circuit_open_until = None
        client._was_half_open = False

        # Use real methods
        client._record_failure = OpenRouterClient._record_failure.__get__(client)
        client._check_circuit = OpenRouterClient._check_circuit.__get__(client)
        client._record_success = OpenRouterClient._record_success.__get__(client)

        for _ in range(5):
            client._record_failure()

        assert client._circuit_open_until is not None

        with pytest.raises(LLMCircuitOpenError):
            client._check_circuit()

    def test_resets_on_success(self):
        """A single success resets the failure counter."""
        from vincera.core.llm import OpenRouterClient

        client = MagicMock(spec=OpenRouterClient)
        client._consecutive_failures = 0
        client._circuit_open_until = None
        client._was_half_open = False

        client._record_failure = OpenRouterClient._record_failure.__get__(client)
        client._record_success = OpenRouterClient._record_success.__get__(client)

        for _ in range(4):
            client._record_failure()

        assert client._consecutive_failures == 4

        client._record_success()

        assert client._consecutive_failures == 0
        assert client._circuit_open_until is None

    def test_half_open_after_cooldown(self):
        """After cooldown, circuit enters half-open state."""
        from vincera.core.llm import OpenRouterClient

        client = MagicMock(spec=OpenRouterClient)
        client._consecutive_failures = 0
        client._circuit_open_until = None
        client._was_half_open = False

        client._record_failure = OpenRouterClient._record_failure.__get__(client)
        client._check_circuit = OpenRouterClient._check_circuit.__get__(client)

        for _ in range(5):
            client._record_failure()

        # Simulate cooldown expired
        client._circuit_open_until = time.monotonic() - 1

        # Should not raise — circuit is half-open
        client._check_circuit()
        assert client._was_half_open is True

    def test_llm_imports_from_errors_module(self):
        """LLM exceptions are importable from both vincera.core.llm and vincera.utils.errors."""
        from vincera.core.llm import LLMCircuitOpenError as LLMFromLLM
        from vincera.utils.errors import LLMCircuitOpenError as LLMFromErrors

        assert LLMFromLLM is LLMFromErrors


# ===========================================================================
# Test 4: Secret redaction
# ===========================================================================

class TestSecretRedaction:
    def test_api_key_redacted(self):
        """API keys (sk-or-...) are redacted from log output."""
        from vincera.utils.logging import SecretRedactionFilter

        f = SecretRedactionFilter()
        record = logging.LogRecord(
            "test", logging.INFO, "", 0,
            "Using key sk-or-abc123def456ghi789jkl012mno345pqr678",
            (), None,
        )
        f.filter(record)
        assert "sk-or-" not in record.msg
        assert "***REDACTED_API_KEY***" in record.msg

    def test_jwt_token_redacted(self):
        """JWT-like tokens (Supabase keys) are redacted."""
        from vincera.utils.logging import SecretRedactionFilter

        f = SecretRedactionFilter()
        token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiYXVkIjoiYXV0aGVudGljYXRlZCJ9.abc123xyz"
        record = logging.LogRecord(
            "test", logging.INFO, "", 0,
            f"Connecting with {token}", (), None,
        )
        f.filter(record)
        assert "eyJ" not in record.msg
        assert "***REDACTED_TOKEN***" in record.msg

    def test_connection_string_password_redacted(self):
        """Database connection string passwords are redacted."""
        from vincera.utils.logging import SecretRedactionFilter

        f = SecretRedactionFilter()
        record = logging.LogRecord(
            "test", logging.INFO, "", 0,
            "DB: postgres://admin:s3cret_pass@db.example.com:5432/vincera",
            (), None,
        )
        f.filter(record)
        assert "s3cret_pass" not in record.msg
        assert "postgres://admin:***@db.example.com" in record.msg

    def test_key_value_pattern_redacted(self):
        """Known secret field names have their values redacted."""
        from vincera.utils.logging import SecretRedactionFilter

        f = SecretRedactionFilter()
        record = logging.LogRecord(
            "test", logging.INFO, "", 0,
            "Config loaded: api_key=sk12345abcdef service_key=mysecret",
            (), None,
        )
        f.filter(record)
        assert "sk12345" not in record.msg
        assert "mysecret" not in record.msg

    def test_normal_message_unchanged(self):
        """Messages without secrets pass through unmodified."""
        from vincera.utils.logging import SecretRedactionFilter

        f = SecretRedactionFilter()
        msg = "Discovery completed: found 47 packages"
        record = logging.LogRecord("test", logging.INFO, "", 0, msg, (), None)
        f.filter(record)
        assert record.msg == msg

    def test_filter_always_returns_true(self):
        """Filter never drops records — always returns True."""
        from vincera.utils.logging import SecretRedactionFilter

        f = SecretRedactionFilter()
        record = logging.LogRecord(
            "test", logging.INFO, "", 0,
            "sk-or-abc123def456ghi789jkl012mno345pqr678",
            (), None,
        )
        assert f.filter(record) is True


# ===========================================================================
# Test 5: Resource monitoring
# ===========================================================================

class TestResourceMonitoring:
    def _make_monitor(self):
        sb = MagicMock()
        sb.log_event.return_value = {"id": "ev-1"}
        sb.update_company.return_value = {"id": "comp-1"}
        sb.send_message.return_value = {"id": "msg-1"}

        config = MagicMock()
        config.home_dir = Path("/tmp")
        config.company_id = "comp-1"

        from vincera.utils.resources import ResourceMonitor
        monitor = ResourceMonitor(supabase=sb, config=config)
        return monitor, sb

    @patch("vincera.utils.resources.psutil")
    def test_disk_warning_at_90_percent(self, mock_psutil):
        """Resource monitor warns at 90% disk usage."""
        monitor, sb = self._make_monitor()

        disk = MagicMock()
        disk.percent = 91.0
        mock_psutil.disk_usage.return_value = disk

        memory = MagicMock()
        memory.percent = 50.0
        mock_psutil.virtual_memory.return_value = memory

        status = _run(monitor.check())

        assert "disk_warning" in status["actions_taken"]
        sb.log_event.assert_called()

    @patch("vincera.utils.resources.psutil")
    def test_disk_pause_at_95_percent(self, mock_psutil):
        """Resource monitor pauses system at 95% disk usage."""
        monitor, sb = self._make_monitor()

        disk = MagicMock()
        disk.percent = 96.0
        mock_psutil.disk_usage.return_value = disk

        memory = MagicMock()
        memory.percent = 50.0
        mock_psutil.virtual_memory.return_value = memory

        status = _run(monitor.check())

        assert "system_paused_disk" in status["actions_taken"]
        sb.update_company.assert_called()
        sb.send_message.assert_called()

    @patch("vincera.utils.resources.psutil")
    def test_memory_warning_at_80_percent(self, mock_psutil):
        """Resource monitor warns at 80% memory usage."""
        monitor, sb = self._make_monitor()

        disk = MagicMock()
        disk.percent = 50.0
        mock_psutil.disk_usage.return_value = disk

        memory = MagicMock()
        memory.percent = 82.0
        mock_psutil.virtual_memory.return_value = memory

        status = _run(monitor.check())

        assert "memory_warning" in status["actions_taken"]
        sb.log_event.assert_called()

    @patch("vincera.utils.resources.psutil")
    def test_healthy_no_actions(self, mock_psutil):
        """No actions when usage is within normal range."""
        monitor, sb = self._make_monitor()

        disk = MagicMock()
        disk.percent = 50.0
        mock_psutil.disk_usage.return_value = disk

        memory = MagicMock()
        memory.percent = 40.0
        mock_psutil.virtual_memory.return_value = memory

        status = _run(monitor.check())

        assert status["actions_taken"] == []
        sb.log_event.assert_not_called()


# ===========================================================================
# Test 6: Security audit
# ===========================================================================

class TestSecurityAudit:
    def test_no_service_key_in_dashboard(self):
        """Dashboard source code must not contain service_key references."""
        import subprocess

        dashboard_src = Path(__file__).parent.parent.parent / "dashboard" / "src"
        if not dashboard_src.exists():
            pytest.skip("dashboard/src not found")

        result = subprocess.run(
            [
                "grep", "-ri",
                r"service_key\|SERVICE_ROLE\|service_role_key",
                str(dashboard_src),
                "--include=*.ts", "--include=*.tsx", "--include=*.js",
            ],
            capture_output=True,
            text=True,
        )
        assert result.stdout.strip() == "", (
            f"Found service_key references in dashboard:\n{result.stdout}"
        )
