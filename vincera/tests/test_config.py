"""Tests for vincera.config, vincera.utils.crypto, and vincera.platform."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from vincera.utils.crypto import (
    ENCRYPTED_PREFIX,
    decrypt,
    encrypt,
    is_encrypted,
)


# ============================================================
# Crypto tests
# ============================================================


class TestCrypto:
    def test_encrypt_adds_prefix(self) -> None:
        result = encrypt("my-secret")
        assert result.startswith(ENCRYPTED_PREFIX)

    def test_decrypt_roundtrip(self) -> None:
        original = "my-secret-api-key-12345"
        encrypted = encrypt(original)
        decrypted = decrypt(encrypted)
        assert decrypted == original

    def test_decrypt_plaintext_passthrough(self) -> None:
        plaintext = "not-encrypted"
        assert decrypt(plaintext) == plaintext

    def test_encrypt_idempotent(self) -> None:
        original = "my-secret"
        encrypted_once = encrypt(original)
        encrypted_twice = encrypt(encrypted_once)
        assert encrypted_once == encrypted_twice

    def test_is_encrypted(self) -> None:
        assert is_encrypted(f"{ENCRYPTED_PREFIX}something") is True
        assert is_encrypted("plaintext") is False


# ============================================================
# Config tests
# ============================================================


class TestConfig:
    def test_loads_from_env(
        self, env_vars: dict[str, str], tmp_home: Path, clear_settings_cache: None
    ) -> None:
        from vincera.config import VinceraSettings

        settings = VinceraSettings()
        assert settings.company_name == "TestCorp"
        assert settings.agent_name == "test-agent"
        assert settings.openrouter_api_key == "test-openrouter-key-12345"

    def test_default_models(
        self, env_vars: dict[str, str], tmp_home: Path, clear_settings_cache: None
    ) -> None:
        from vincera.config import VinceraSettings

        settings = VinceraSettings()
        assert settings.orchestrator_model == "anthropic/claude-opus-4-5"
        assert settings.agent_model == "anthropic/claude-sonnet-4-5"
        assert settings.ghost_mode_days == 7

    def test_home_dir_resolved(
        self, env_vars: dict[str, str], tmp_home: Path, clear_settings_cache: None
    ) -> None:
        from vincera.config import VinceraSettings

        settings = VinceraSettings()
        assert settings.home_dir.is_absolute()
        assert settings.home_dir == tmp_home.resolve()

    def test_ensure_directories(
        self, env_vars: dict[str, str], tmp_home: Path, clear_settings_cache: None
    ) -> None:
        from vincera.config import VinceraSettings

        settings = VinceraSettings()
        settings.ensure_directories()

        expected_dirs = [
            "core", "agents", "scripts", "knowledge",
            "inbox", "outbox", "logs", "deployments", "training",
        ]
        for name in expected_dirs:
            assert (settings.home_dir / name).is_dir(), f"Missing dir: {name}"

    def test_company_id_optional(
        self, env_vars: dict[str, str], tmp_home: Path, clear_settings_cache: None
    ) -> None:
        from vincera.config import VinceraSettings

        settings = VinceraSettings()
        assert settings.company_id is None

    def test_loads_encrypted_values(
        self, tmp_home: Path, clear_settings_cache: None
    ) -> None:
        """Config should transparently decrypt ENC:-prefixed values."""
        from vincera.config import VinceraSettings

        encrypted_api_key = encrypt("real-api-key")
        encrypted_svc_key = encrypt("real-service-key")

        os.environ["OPENROUTER_API_KEY"] = encrypted_api_key
        os.environ["COMPANY_NAME"] = "TestCorp"
        os.environ["SUPABASE_URL"] = "https://test.supabase.co"
        os.environ["SUPABASE_ANON_KEY"] = "test-anon-key"
        os.environ["SUPABASE_SERVICE_KEY"] = encrypted_svc_key
        os.environ["HOME_DIR"] = str(tmp_home)

        try:
            settings = VinceraSettings()
            assert settings.openrouter_api_key == "real-api-key"
            assert settings.supabase_service_key == "real-service-key"
        finally:
            for k in [
                "OPENROUTER_API_KEY", "COMPANY_NAME", "SUPABASE_URL",
                "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY", "HOME_DIR",
            ]:
                os.environ.pop(k, None)

    def test_encrypt_env_file(
        self, env_vars: dict[str, str], tmp_path: Path, clear_settings_cache: None
    ) -> None:
        """encrypt_env_file should encrypt sensitive keys in the .env file."""
        from vincera.config import VinceraSettings

        env_file = tmp_path / ".env"
        env_file.write_text(
            "OPENROUTER_API_KEY=plain-key\n"
            "COMPANY_NAME=TestCorp\n"
            "SUPABASE_SERVICE_KEY=plain-service-key\n"
        )

        settings = VinceraSettings()
        settings.encrypt_env_file(env_file)

        content = env_file.read_text()
        lines = {
            line.split("=", 1)[0]: line.split("=", 1)[1]
            for line in content.strip().splitlines()
            if "=" in line
        }
        assert lines["OPENROUTER_API_KEY"].startswith(ENCRYPTED_PREFIX)
        assert lines["COMPANY_NAME"] == "TestCorp"
        assert lines["SUPABASE_SERVICE_KEY"].startswith(ENCRYPTED_PREFIX)

        # Verify the encrypted values decrypt correctly
        assert decrypt(lines["OPENROUTER_API_KEY"]) == "plain-key"
        assert decrypt(lines["SUPABASE_SERVICE_KEY"]) == "plain-service-key"

    def test_get_settings_singleton(
        self, env_vars: dict[str, str], tmp_home: Path, clear_settings_cache: None
    ) -> None:
        from vincera.config import get_settings

        s1 = get_settings()
        s2 = get_settings()
        assert s1 is s2


# ============================================================
# Platform tests
# ============================================================


class TestPlatform:
    def test_os_type_is_valid(self) -> None:
        from vincera.platform import os_type

        assert os_type in ("macos", "linux", "windows")

    def test_os_type_is_macos_on_darwin(self) -> None:
        from vincera.platform import os_type

        assert os_type == "macos"
