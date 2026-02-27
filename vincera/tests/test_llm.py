"""Tests for vincera.core.llm and vincera.utils.db — all httpx calls are mocked."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from vincera.utils.db import VinceraDB


# ============================================================
# Helpers
# ============================================================


def _make_openrouter_json(
    content: str = "Hello",
    model: str = "anthropic/claude-sonnet-4-5",
    tokens_in: int = 10,
    tokens_out: int = 20,
    tool_calls: list | None = None,
) -> dict:
    """Build a realistic OpenRouter chat completion JSON body."""
    message: dict = {"role": "assistant", "content": content}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
        message["content"] = None
    return {
        "id": "gen-test-123",
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": tokens_in,
            "completion_tokens": tokens_out,
            "total_tokens": tokens_in + tokens_out,
        },
    }


def _mock_response(status: int = 200, **json_kwargs) -> httpx.Response:
    """Create a mock httpx.Response."""
    body = _make_openrouter_json(**json_kwargs)
    return httpx.Response(
        status_code=status,
        json=body,
        request=httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions"),
    )


def _run(coro):
    """Run an async coroutine synchronously."""
    return asyncio.run(coro)


def _make_client(tmp_path: Path, **overrides):
    """Create an OpenRouterClient with test defaults."""
    from vincera.core.llm import OpenRouterClient

    defaults = dict(
        api_key="test-key",
        default_model="anthropic/claude-sonnet-4-5",
        company_name="TestCorp",
        agent_name="test-agent",
        db_path=tmp_path / "test.db",
    )
    defaults.update(overrides)
    return OpenRouterClient(**defaults)


# ============================================================
# VinceraDB tests
# ============================================================


class TestVinceraDB:
    def test_creates_tables(self, tmp_path: Path) -> None:
        db = VinceraDB(tmp_path / "test.db")
        rows = db.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage'"
        )
        assert len(rows) == 1
        db.close()

    def test_execute_and_query(self, tmp_path: Path) -> None:
        db = VinceraDB(tmp_path / "test.db")
        row_id = db.execute(
            "INSERT INTO token_usage (timestamp, model, tokens_in, tokens_out, cost_estimate, agent_name) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("2025-01-01T00:00:00", "test-model", 10, 20, 0.001, "agent"),
        )
        assert row_id == 1

        rows = db.query("SELECT * FROM token_usage WHERE id = ?", (row_id,))
        assert len(rows) == 1
        assert rows[0]["model"] == "test-model"
        assert rows[0]["tokens_in"] == 10
        db.close()

    def test_creates_parent_dirs(self, tmp_path: Path) -> None:
        db_path = tmp_path / "nested" / "dirs" / "test.db"
        db = VinceraDB(db_path)
        assert db_path.exists()
        db.close()


# ============================================================
# OpenRouterClient — think()
# ============================================================


class TestThink:
    def test_returns_string(self, tmp_path: Path) -> None:
        client = _make_client(tmp_path)
        mock_resp = _mock_response(content="Test response")

        with patch.object(client._http, "post", new_callable=AsyncMock, return_value=mock_resp):
            result = _run(client.think("You are helpful.", "Say hello"))

        assert result == "Test response"
        _run(client.close())

    def test_system_prefix_injected(self, tmp_path: Path) -> None:
        client = _make_client(tmp_path)
        mock_resp = _mock_response(content="ok")
        captured_kwargs: dict = {}

        async def capture_post(*args, **kwargs):
            captured_kwargs.update(kwargs)
            return mock_resp

        with patch.object(client._http, "post", side_effect=capture_post):
            _run(client.think("Be precise.", "What?"))

        body = captured_kwargs.get("json", {})
        system_msg = body["messages"][0]["content"]
        assert "test-agent" in system_msg
        assert "TestCorp" in system_msg
        assert "Be precise." in system_msg
        _run(client.close())


# ============================================================
# OpenRouterClient — think_structured()
# ============================================================


class TestThinkStructured:
    def test_returns_dict_from_tool_call(self, tmp_path: Path) -> None:
        client = _make_client(tmp_path)
        schema = {
            "type": "object",
            "properties": {"name": {"type": "string"}, "age": {"type": "integer"}},
            "required": ["name", "age"],
        }
        tool_calls = [
            {
                "id": "call_1",
                "type": "function",
                "function": {
                    "name": "structured_response",
                    "arguments": json.dumps({"name": "Alice", "age": 30}),
                },
            }
        ]
        mock_resp = _mock_response(tool_calls=tool_calls)

        with patch.object(client._http, "post", new_callable=AsyncMock, return_value=mock_resp):
            result = _run(client.think_structured("System.", "Query.", schema))

        assert result == {"name": "Alice", "age": 30}
        _run(client.close())

    def test_fallback_to_json_prompt(self, tmp_path: Path) -> None:
        client = _make_client(tmp_path)
        schema = {"type": "object", "properties": {"x": {"type": "integer"}}}

        # First call (tool calling) fails, second call (json prompt) succeeds
        fail_resp = httpx.Response(
            status_code=400,
            json={"error": {"message": "tools not supported"}},
            request=httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions"),
        )
        ok_resp = _mock_response(content='{"x": 42}')

        call_count = 0

        async def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count <= 3:  # 3 retries for the tool call attempt
                return fail_resp
            return ok_resp

        with patch.object(client._http, "post", side_effect=side_effect):
            result = _run(client.think_structured("System.", "Query.", schema))

        assert result == {"x": 42}
        _run(client.close())


# ============================================================
# Retry behavior
# ============================================================


class TestRetry:
    def test_retries_on_429(self, tmp_path: Path) -> None:
        client = _make_client(tmp_path)
        rate_limit_resp = httpx.Response(
            status_code=429,
            json={"error": {"message": "rate limited"}},
            request=httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions"),
        )
        ok_resp = _mock_response(content="ok")

        call_count = 0

        async def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                return rate_limit_resp
            return ok_resp

        with patch.object(client._http, "post", side_effect=side_effect):
            with patch("vincera.core.llm.asyncio.sleep", new_callable=AsyncMock):
                result = _run(client.think("sys", "msg"))

        assert result == "ok"
        assert call_count == 3
        _run(client.close())

    def test_retries_on_5xx(self, tmp_path: Path) -> None:
        client = _make_client(tmp_path)
        error_resp = httpx.Response(
            status_code=500,
            json={"error": {"message": "server error"}},
            request=httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions"),
        )
        ok_resp = _mock_response(content="recovered")

        call_count = 0

        async def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                return error_resp
            return ok_resp

        with patch.object(client._http, "post", side_effect=side_effect):
            with patch("vincera.core.llm.asyncio.sleep", new_callable=AsyncMock):
                result = _run(client.think("sys", "msg"))

        assert result == "recovered"
        assert call_count == 3
        _run(client.close())


# ============================================================
# Circuit breaker
# ============================================================


class TestCircuitBreaker:
    def test_opens_after_5_failures(self, tmp_path: Path) -> None:
        from vincera.core.llm import LLMCircuitOpenError

        client = _make_client(tmp_path)
        error_resp = httpx.Response(
            status_code=500,
            json={"error": {"message": "fail"}},
            request=httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions"),
        )

        with patch.object(client._http, "post", new_callable=AsyncMock, return_value=error_resp):
            with patch("vincera.core.llm.asyncio.sleep", new_callable=AsyncMock):
                # Each think() call tries primary + default + haiku fallback
                # Each _call_api does 3 retries. Need enough failures to hit threshold.
                for _ in range(5):
                    with pytest.raises(Exception):
                        _run(client.think("sys", "msg"))

                # Circuit should now be open
                with pytest.raises(LLMCircuitOpenError):
                    _run(client.think("sys", "msg"))

        _run(client.close())

    def test_resets_after_cooldown(self, tmp_path: Path) -> None:
        from vincera.core.llm import LLMCircuitOpenError

        client = _make_client(tmp_path)
        error_resp = httpx.Response(
            status_code=500,
            json={"error": {"message": "fail"}},
            request=httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions"),
        )
        ok_resp = _mock_response(content="back online")

        with patch.object(client._http, "post", new_callable=AsyncMock, return_value=error_resp):
            with patch("vincera.core.llm.asyncio.sleep", new_callable=AsyncMock):
                for _ in range(5):
                    with pytest.raises(Exception):
                        _run(client.think("sys", "msg"))

        # Circuit is open — verify
        with pytest.raises(LLMCircuitOpenError):
            with patch.object(client._http, "post", new_callable=AsyncMock, return_value=error_resp):
                _run(client.think("sys", "msg"))

        # Fast-forward past cooldown
        client._circuit_open_until = time.monotonic() - 1

        with patch.object(client._http, "post", new_callable=AsyncMock, return_value=ok_resp):
            result = _run(client.think("sys", "msg"))

        assert result == "back online"
        assert client._consecutive_failures == 0
        _run(client.close())


# ============================================================
# Fallback chain
# ============================================================


class TestFallbackChain:
    def test_falls_back_on_primary_failure(self, tmp_path: Path) -> None:
        client = _make_client(tmp_path)
        error_resp = httpx.Response(
            status_code=500,
            json={"error": {"message": "fail"}},
            request=httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions"),
        )
        ok_resp = _mock_response(content="fallback worked", model="anthropic/claude-haiku-4-5")

        models_tried: list[str] = []

        async def side_effect(*args, **kwargs):
            body = kwargs.get("json", {})
            model = body.get("model", "")
            models_tried.append(model)
            if model != "anthropic/claude-haiku-4-5":
                return error_resp
            return ok_resp

        with patch.object(client._http, "post", side_effect=side_effect):
            with patch("vincera.core.llm.asyncio.sleep", new_callable=AsyncMock):
                result = _run(client.think("sys", "msg", model="custom/model"))

        assert result == "fallback worked"
        # Should have tried: custom/model (3x retry), default model (3x retry), haiku (1x success)
        assert "custom/model" in models_tried
        assert "anthropic/claude-haiku-4-5" in models_tried
        _run(client.close())


# ============================================================
# Token usage logging
# ============================================================


class TestTokenLogging:
    def test_logged_after_success(self, tmp_path: Path) -> None:
        client = _make_client(tmp_path)
        mock_resp = _mock_response(content="hi", tokens_in=15, tokens_out=25)

        with patch.object(client._http, "post", new_callable=AsyncMock, return_value=mock_resp):
            _run(client.think("sys", "msg"))

        rows = client._db.query("SELECT * FROM token_usage")
        assert len(rows) == 1
        assert rows[0]["tokens_in"] == 15
        assert rows[0]["tokens_out"] == 25
        assert rows[0]["agent_name"] == "test-agent"
        _run(client.close())


# ============================================================
# think_with_tools
# ============================================================


class TestThinkWithTools:
    def test_tool_call_loop(self, tmp_path: Path) -> None:
        client = _make_client(tmp_path)
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get weather",
                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                },
            }
        ]

        # First response: tool call
        tool_call_resp = _mock_response(
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "get_weather", "arguments": '{"city": "NYC"}'},
                }
            ]
        )
        # Second response: text (after tool result provided)
        text_resp = _mock_response(content="The weather in NYC is sunny.")

        call_count = 0

        async def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return tool_call_resp
            return text_resp

        with patch.object(client._http, "post", side_effect=side_effect):
            messages = [{"role": "user", "content": "What's the weather in NYC?"}]
            tool_results = {"call_1": "Sunny, 72F"}
            history = _run(client.think_with_tools("sys", messages, tools, tool_results_fn=lambda tc: "Sunny, 72F"))

        assert call_count == 2
        # History should contain the final assistant text
        assert any(m.get("content") == "The weather in NYC is sunny." for m in history)
        _run(client.close())


# ============================================================
# research()
# ============================================================


class TestResearch:
    def test_tries_perplexity_first(self, tmp_path: Path) -> None:
        client = _make_client(tmp_path)
        ok_resp = _mock_response(content="Research result", model="perplexity/sonar-pro")

        models_tried: list[str] = []

        async def side_effect(*args, **kwargs):
            body = kwargs.get("json", {})
            models_tried.append(body.get("model", ""))
            return ok_resp

        with patch.object(client._http, "post", side_effect=side_effect):
            result = _run(client.research("What is AI?"))

        assert result == "Research result"
        assert models_tried[0] == "perplexity/sonar-pro"
        _run(client.close())
