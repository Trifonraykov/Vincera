"""Shared test fixtures for Vincera Bot tests."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Generator

import pytest


@pytest.fixture
def tmp_home(tmp_path: Path) -> Path:
    """Provide a temporary directory to use as VinceraHQ home."""
    home = tmp_path / "VinceraHQ"
    home.mkdir()
    return home


@pytest.fixture
def env_vars(tmp_home: Path) -> Generator[dict[str, str], None, None]:
    """Set minimal environment variables for VinceraSettings and clean up."""
    test_vars = {
        "OPENROUTER_API_KEY": "test-openrouter-key-12345",
        "COMPANY_NAME": "TestCorp",
        "AGENT_NAME": "test-agent",
        "SUPABASE_URL": "https://test.supabase.co",
        "SUPABASE_ANON_KEY": "test-anon-key",
        "SUPABASE_SERVICE_KEY": "test-service-key-67890",
        "HOME_DIR": str(tmp_home),
    }
    for key, value in test_vars.items():
        os.environ[key] = value

    yield test_vars

    for key in test_vars:
        os.environ.pop(key, None)


@pytest.fixture
def clear_settings_cache() -> Generator[None, None, None]:
    """Clear the get_settings LRU cache before and after each test."""
    from vincera.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
