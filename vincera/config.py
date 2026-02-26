"""Vincera Bot configuration via Pydantic Settings.

Usage:
    from vincera.config import get_settings

    settings = get_settings()
    print(settings.company_name)
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Optional

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from vincera.utils.crypto import decrypt, encrypt, is_encrypted

_HQ_SUBDIRS = [
    "core",
    "agents",
    "scripts",
    "knowledge",
    "inbox",
    "outbox",
    "logs",
    "deployments",
    "training",
]


class VinceraSettings(BaseSettings):
    """Central configuration for Vincera Bot."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # API Keys (encrypted at rest)
    openrouter_api_key: str = Field(...)
    # Company Identity
    company_name: str = Field(...)
    agent_name: str = Field(default="vincera")
    company_id: Optional[str] = Field(default=None)
    # Supabase
    supabase_url: str = Field(...)
    supabase_anon_key: str = Field(...)
    supabase_service_key: str = Field(...)
    # File System
    home_dir: Path = Field(default=Path("~/VinceraHQ"))
    # Model Selection
    orchestrator_model: str = Field(default="anthropic/claude-opus-4-5")
    agent_model: str = Field(default="anthropic/claude-sonnet-4-5")
    # Behavior
    ghost_mode_days: int = Field(default=7)

    @field_validator("home_dir", mode="before")
    @classmethod
    def expand_home_dir(cls, v: str | Path) -> Path:
        return Path(os.path.expanduser(str(v))).resolve()

    @model_validator(mode="after")
    def decrypt_sensitive_fields(self) -> "VinceraSettings":
        if is_encrypted(self.openrouter_api_key):
            object.__setattr__(
                self, "openrouter_api_key", decrypt(self.openrouter_api_key)
            )
        if is_encrypted(self.supabase_service_key):
            object.__setattr__(
                self, "supabase_service_key", decrypt(self.supabase_service_key)
            )
        return self

    def ensure_directories(self) -> None:
        """Create the VinceraHQ directory tree."""
        for subdir in _HQ_SUBDIRS:
            (self.home_dir / subdir).mkdir(parents=True, exist_ok=True)

    def encrypt_env_file(self, env_path: str | Path | None = None) -> None:
        """Encrypt sensitive fields in a .env file in-place."""
        path = Path(env_path) if env_path else Path(".env")
        if not path.exists():
            return

        lines = path.read_text(encoding="utf-8").splitlines()
        sensitive_keys = {"OPENROUTER_API_KEY", "SUPABASE_SERVICE_KEY"}
        new_lines: list[str] = []

        for line in lines:
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                key, _, value = stripped.partition("=")
                key = key.strip()
                value = value.strip()
                if key in sensitive_keys and not is_encrypted(value):
                    value = encrypt(value)
                    new_lines.append(f"{key}={value}")
                    continue
            new_lines.append(line)

        path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")


    @property
    def logs_dir(self) -> Path:
        """Path to the logs directory inside VinceraHQ."""
        return self.home_dir / "logs"


@lru_cache(maxsize=1)
def get_settings() -> VinceraSettings:
    """Get the singleton VinceraSettings instance."""
    settings = VinceraSettings()
    settings.ensure_directories()
    return settings
