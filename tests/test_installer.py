"""Tests for vincera.installer — all network calls mocked."""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# ============================================================
# Helpers
# ============================================================


def _installer_env_vars(tmp_path: Path) -> dict[str, str]:
    """Return env vars for non-interactive installer runs."""
    return {
        "COMPANY_NAME": "TestCorp",
        "AGENT_NAME": "testbot",
        "OPENROUTER_API_KEY": "sk-or-test-key-123",
        "SUPABASE_URL": "https://test.supabase.co",
        "SUPABASE_ANON_KEY": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-anon",
        "SUPABASE_SERVICE_KEY": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-service",
        "HOME_DIR": str(tmp_path / "VinceraHQ"),
    }


# ============================================================
# Validation helpers
# ============================================================


class TestValidateOpenRouterKey:
    def test_success(self) -> None:
        from vincera.installer import validate_openrouter_key

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        with patch("vincera.installer.httpx.get", return_value=mock_resp):
            assert validate_openrouter_key("sk-or-valid") is True

    def test_failure_401(self) -> None:
        from vincera.installer import validate_openrouter_key

        mock_resp = MagicMock()
        mock_resp.status_code = 401
        with patch("vincera.installer.httpx.get", return_value=mock_resp):
            assert validate_openrouter_key("sk-or-bad") is False

    def test_network_error(self) -> None:
        from vincera.installer import validate_openrouter_key

        with patch("vincera.installer.httpx.get", side_effect=Exception("timeout")):
            assert validate_openrouter_key("sk-or-any") is False


class TestValidateSupabase:
    def test_success(self) -> None:
        from vincera.installer import validate_supabase_connection

        mock_client = MagicMock()
        mock_client.table.return_value.select.return_value.limit.return_value.execute.return_value = MagicMock(data=[])
        with patch("vincera.installer.create_client", return_value=mock_client):
            assert validate_supabase_connection("https://x.supabase.co", "key") is True

    def test_failure(self) -> None:
        from vincera.installer import validate_supabase_connection

        with patch("vincera.installer.create_client", side_effect=Exception("bad url")):
            assert validate_supabase_connection("https://bad.co", "key") is False


# ============================================================
# Full installer flow (non-interactive)
# ============================================================


class TestRunInstaller:
    def test_non_interactive_success(self, tmp_path: Path) -> None:
        from vincera.installer import run_installer

        env_path = tmp_path / ".env"
        env_vars = _installer_env_vars(tmp_path)

        mock_resp = MagicMock()
        mock_resp.status_code = 200

        mock_sb_client = MagicMock()
        mock_sb_client.table.return_value.select.return_value.limit.return_value.execute.return_value = MagicMock(data=[])
        mock_sb_client.table.return_value.insert.return_value.execute.return_value = MagicMock(
            data=[{"id": "comp-new-123"}]
        )

        with (
            patch.dict(os.environ, env_vars, clear=False),
            patch("vincera.installer.httpx.get", return_value=mock_resp),
            patch("vincera.installer.create_client", return_value=mock_sb_client),
        ):
            result = run_installer(non_interactive=True, env_path=env_path)

        assert result is True
        assert env_path.exists()

    def test_writes_env_file(self, tmp_path: Path) -> None:
        from vincera.installer import run_installer

        env_path = tmp_path / ".env"
        env_vars = _installer_env_vars(tmp_path)

        mock_resp = MagicMock()
        mock_resp.status_code = 200

        mock_sb_client = MagicMock()
        mock_sb_client.table.return_value.select.return_value.limit.return_value.execute.return_value = MagicMock(data=[])
        mock_sb_client.table.return_value.insert.return_value.execute.return_value = MagicMock(
            data=[{"id": "comp-456"}]
        )

        with (
            patch.dict(os.environ, env_vars, clear=False),
            patch("vincera.installer.httpx.get", return_value=mock_resp),
            patch("vincera.installer.create_client", return_value=mock_sb_client),
        ):
            run_installer(non_interactive=True, env_path=env_path)

        content = env_path.read_text()
        assert "COMPANY_NAME=TestCorp" in content
        assert "SUPABASE_URL=https://test.supabase.co" in content

    def test_encrypts_secrets(self, tmp_path: Path) -> None:
        from vincera.installer import run_installer
        from vincera.utils.crypto import is_encrypted

        env_path = tmp_path / ".env"
        env_vars = _installer_env_vars(tmp_path)

        mock_resp = MagicMock()
        mock_resp.status_code = 200

        mock_sb_client = MagicMock()
        mock_sb_client.table.return_value.select.return_value.limit.return_value.execute.return_value = MagicMock(data=[])
        mock_sb_client.table.return_value.insert.return_value.execute.return_value = MagicMock(
            data=[{"id": "comp-789"}]
        )

        with (
            patch.dict(os.environ, env_vars, clear=False),
            patch("vincera.installer.httpx.get", return_value=mock_resp),
            patch("vincera.installer.create_client", return_value=mock_sb_client),
        ):
            run_installer(non_interactive=True, env_path=env_path)

        content = env_path.read_text()
        for line in content.splitlines():
            if line.startswith("OPENROUTER_API_KEY=") or line.startswith("SUPABASE_SERVICE_KEY="):
                _, _, val = line.partition("=")
                assert is_encrypted(val), f"Expected encrypted value for {line}"

    def test_network_failure_returns_false(self, tmp_path: Path) -> None:
        from vincera.installer import run_installer

        env_path = tmp_path / ".env"
        env_vars = _installer_env_vars(tmp_path)

        with (
            patch.dict(os.environ, env_vars, clear=False),
            patch("vincera.installer.httpx.get", side_effect=Exception("offline")),
        ):
            result = run_installer(non_interactive=True, env_path=env_path)

        assert result is False
