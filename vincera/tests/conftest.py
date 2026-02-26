"""Shared test fixtures for Vincera Bot tests."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Generator
from unittest.mock import AsyncMock, MagicMock

import pytest


# ---------------------------------------------------------------------------
# Existing fixtures
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Shared mock fixtures for E2E tests
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_config(tmp_home: Path) -> MagicMock:
    """Mock VinceraSettings config."""
    config = MagicMock()
    (tmp_home / "knowledge").mkdir(parents=True, exist_ok=True)
    config.home_dir = tmp_home
    config.company_id = "comp-1"
    config.company_name = "TestCorp"
    config.agent_name = "test-agent"
    config.ghost_mode_days = 7
    return config


@pytest.fixture
def mock_supabase() -> MagicMock:
    """Mock SupabaseManager with all commonly used methods pre-configured."""
    sb = MagicMock()
    sb.get_latest_brain_state.return_value = None
    sb.save_brain_state.return_value = {"id": "bs-1"}
    sb.send_message.return_value = {"id": "msg-1"}
    sb.log_event.return_value = {"id": "ev-1"}
    sb.get_company.return_value = {"authority_level": "ask_risky"}
    sb.resolve_decision.return_value = {"id": "dec-1"}
    sb.save_ghost_report.return_value = {"id": "gr-1"}
    sb.get_ghost_reports.return_value = []
    sb.update_company.return_value = {"id": "comp-1"}
    sb.update_agent_status.return_value = None
    sb.get_new_messages.return_value = []
    sb.register_company.return_value = {"id": "comp-1"}
    sb.query_knowledge.return_value = []
    return sb


@pytest.fixture
def mock_llm() -> MagicMock:
    """Mock OpenRouterClient with async methods."""
    llm = MagicMock()
    llm.think = AsyncMock(return_value="ok")
    llm.think_structured = AsyncMock(return_value={})
    llm.think_with_tools = AsyncMock(return_value="ok")
    llm.research = AsyncMock(return_value="ok")
    llm.close = AsyncMock()
    return llm


@pytest.fixture
def mock_state() -> MagicMock:
    """Mock GlobalState."""
    state = MagicMock()
    state.is_paused.return_value = False
    state.set_paused = MagicMock()
    state.update_agent_status = MagicMock()
    state.add_action = MagicMock()
    state.get_agent_status.return_value = {"status": "idle"}
    state._db = MagicMock()
    state._db.query.return_value = []
    return state
