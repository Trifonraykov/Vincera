"""OpenRouter LLM client with retry, circuit breaker, fallback, and token tracking."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import httpx

from vincera.utils.db import VinceraDB

logger = logging.getLogger(__name__)

BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
LAST_RESORT_MODEL = "anthropic/claude-haiku-4-5"
MAX_RETRIES = 3
CIRCUIT_THRESHOLD = 5
CIRCUIT_COOLDOWN = 300  # seconds

_SYSTEM_PREFIX = (
    "You are {agent_name}, a Vincera agent managing operations for {company_name}. "
    "Current time: {timestamp}. Be precise. Cite evidence. Never fabricate data."
)

# Rough per-token costs (USD) for cost estimation
_COST_PER_INPUT_TOKEN = 3e-6
_COST_PER_OUTPUT_TOKEN = 15e-6


class LLMCircuitOpenError(Exception):
    """Raised when the circuit breaker is open and calls are rejected."""


class LLMError(Exception):
    """Raised when all retries and fallbacks are exhausted."""


class OpenRouterClient:
    """Async OpenRouter API client with resilience patterns."""

    def __init__(
        self,
        api_key: str,
        default_model: str,
        company_name: str,
        agent_name: str,
        db_path: Path,
    ) -> None:
        self._api_key = api_key
        self._default_model = default_model
        self._company_name = company_name
        self._agent_name = agent_name
        self._db = VinceraDB(db_path)

        self._http = httpx.AsyncClient(
            headers={
                "Authorization": f"Bearer {api_key}",
                "HTTP-Referer": "https://vincera.ai",
                "X-Title": "Vincera Agent",
            },
            timeout=60.0,
        )

        # Circuit breaker state
        self._consecutive_failures: int = 0
        self._circuit_open_until: float | None = None

    # ------------------------------------------------------------------
    # System prefix
    # ------------------------------------------------------------------

    def _build_system_message(self, system_prompt: str) -> str:
        prefix = _SYSTEM_PREFIX.format(
            agent_name=self._agent_name,
            company_name=self._company_name,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        return f"{prefix}\n\n{system_prompt}"

    # ------------------------------------------------------------------
    # Circuit breaker
    # ------------------------------------------------------------------

    def _check_circuit(self) -> None:
        if self._circuit_open_until is not None:
            if time.monotonic() < self._circuit_open_until:
                raise LLMCircuitOpenError(
                    f"Circuit breaker open. Retry after {self._circuit_open_until - time.monotonic():.0f}s"
                )
            # Cooldown expired — half-open, allow the call
            self._circuit_open_until = None

    def _record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= CIRCUIT_THRESHOLD:
            self._circuit_open_until = time.monotonic() + CIRCUIT_COOLDOWN
            logger.error(
                "Circuit breaker opened after %d consecutive failures",
                self._consecutive_failures,
            )

    def _record_success(self) -> None:
        self._consecutive_failures = 0
        self._circuit_open_until = None

    # ------------------------------------------------------------------
    # Token logging
    # ------------------------------------------------------------------

    def _log_tokens(self, model: str, usage: dict) -> None:
        tokens_in = usage.get("prompt_tokens", 0)
        tokens_out = usage.get("completion_tokens", 0)
        cost = tokens_in * _COST_PER_INPUT_TOKEN + tokens_out * _COST_PER_OUTPUT_TOKEN
        self._db.execute(
            "INSERT INTO token_usage (timestamp, model, tokens_in, tokens_out, cost_estimate, agent_name) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                datetime.now(timezone.utc).isoformat(),
                model,
                tokens_in,
                tokens_out,
                round(cost, 6),
                self._agent_name,
            ),
        )

    # ------------------------------------------------------------------
    # Core API call with retry
    # ------------------------------------------------------------------

    async def _call_api(
        self,
        messages: list[dict],
        model: str,
        tools: list[dict] | None = None,
        tool_choice: str | dict | None = None,
    ) -> dict:
        """Make a single API call with retry on 429/5xx. Manages circuit breaker."""
        self._check_circuit()

        payload: dict[str, Any] = {"model": model, "messages": messages}
        if tools:
            payload["tools"] = tools
        if tool_choice:
            payload["tool_choice"] = tool_choice

        last_error: Exception | None = None

        for attempt in range(MAX_RETRIES):
            try:
                resp = await self._http.post(BASE_URL, json=payload)

                if resp.status_code == 200:
                    data = resp.json()
                    self._record_success()
                    if "usage" in data:
                        self._log_tokens(model, data["usage"])
                    return data

                if resp.status_code in (429, 500, 502, 503, 504):
                    last_error = LLMError(
                        f"HTTP {resp.status_code}: {resp.text[:200]}"
                    )
                    if attempt < MAX_RETRIES - 1:
                        await asyncio.sleep(2**attempt)
                    continue

                # Non-retryable error (4xx other than 429)
                self._record_failure()
                raise LLMError(f"HTTP {resp.status_code}: {resp.text[:200]}")

            except httpx.HTTPError as exc:
                last_error = LLMError(str(exc))
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(2**attempt)
                continue

        # All retries exhausted
        self._record_failure()
        raise last_error or LLMError("All retries exhausted")

    # ------------------------------------------------------------------
    # Fallback wrapper
    # ------------------------------------------------------------------

    async def _call_with_fallback(
        self,
        messages: list[dict],
        model: str | None,
        tools: list[dict] | None = None,
        tool_choice: str | dict | None = None,
    ) -> dict:
        """Try model -> default_model -> haiku fallback chain."""
        primary = model or self._default_model
        chain = [primary]
        if self._default_model != primary:
            chain.append(self._default_model)
        if LAST_RESORT_MODEL not in chain:
            chain.append(LAST_RESORT_MODEL)

        last_exc: Exception | None = None
        for m in chain:
            try:
                return await self._call_api(messages, m, tools, tool_choice)
            except LLMCircuitOpenError:
                raise  # Don't fallback on circuit open
            except Exception as exc:
                last_exc = exc
                if m != chain[-1]:
                    logger.warning("Model %s failed, falling back: %s", m, exc)
                continue

        raise last_exc or LLMError("All models in fallback chain failed")

    # ------------------------------------------------------------------
    # Public methods
    # ------------------------------------------------------------------

    async def think(
        self,
        system_prompt: str,
        user_message: str,
        model: str | None = None,
    ) -> str:
        """Standard chat completion. Returns assistant text."""
        messages = [
            {"role": "system", "content": self._build_system_message(system_prompt)},
            {"role": "user", "content": user_message},
        ]
        data = await self._call_with_fallback(messages, model)
        return data["choices"][0]["message"]["content"]

    async def think_structured(
        self,
        system_prompt: str,
        user_message: str,
        response_schema: dict,
        model: str | None = None,
    ) -> dict:
        """Get structured JSON via tool calling, with fallback to JSON prompting."""
        messages = [
            {"role": "system", "content": self._build_system_message(system_prompt)},
            {"role": "user", "content": user_message},
        ]

        # Primary: tool/function calling
        tool_def = [
            {
                "type": "function",
                "function": {
                    "name": "structured_response",
                    "description": "Return structured data matching the schema.",
                    "parameters": response_schema,
                },
            }
        ]
        try:
            data = await self._call_with_fallback(
                messages, model, tools=tool_def, tool_choice={"type": "function", "function": {"name": "structured_response"}}
            )
            tool_calls = data["choices"][0]["message"].get("tool_calls")
            if tool_calls:
                return json.loads(tool_calls[0]["function"]["arguments"])
        except Exception:
            pass  # Fall through to JSON prompting

        # Fallback: JSON prompting
        schema_str = json.dumps(response_schema, indent=2)
        json_messages = [
            {"role": "system", "content": self._build_system_message(system_prompt)},
            {
                "role": "user",
                "content": f"{user_message}\n\nRespond ONLY in valid JSON matching this schema:\n{schema_str}",
            },
        ]
        data = await self._call_with_fallback(json_messages, model)
        text = data["choices"][0]["message"]["content"]
        return json.loads(text)

    async def think_with_tools(
        self,
        system_prompt: str,
        messages: list[dict],
        tools: list[dict],
        model: str | None = None,
        tool_results_fn: Callable | None = None,
        max_iterations: int = 10,
    ) -> list[dict]:
        """Multi-turn tool-calling loop. Returns full message history."""
        history = [
            {"role": "system", "content": self._build_system_message(system_prompt)},
            *messages,
        ]

        for _ in range(max_iterations):
            data = await self._call_with_fallback(history, model, tools=tools)
            assistant_msg = data["choices"][0]["message"]

            tool_calls = assistant_msg.get("tool_calls")
            if not tool_calls:
                # No tool calls — assistant gave a text response, done
                history.append({"role": "assistant", "content": assistant_msg.get("content", "")})
                break

            # Append the assistant message with tool calls
            history.append(assistant_msg)

            # Execute tools and add results
            for tc in tool_calls:
                result = ""
                if tool_results_fn:
                    result = tool_results_fn(tc)
                history.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": str(result),
                    }
                )

        return history

    async def research(
        self,
        query: str,
        model: str | None = None,
    ) -> str:
        """Research query — tries perplexity/sonar-pro first, then standard completion."""
        research_model = model or "perplexity/sonar-pro"
        system = (
            "You are a research assistant. Provide thorough, evidence-based answers. "
            "Cite sources when possible."
        )
        try:
            return await self.think(system, query, model=research_model)
        except Exception:
            logger.warning(
                "Research model %s failed, falling back to standard completion",
                research_model,
            )
            return await self.think(system, query)

    async def close(self) -> None:
        """Close the HTTP client and database."""
        await self._http.aclose()
        self._db.close()
