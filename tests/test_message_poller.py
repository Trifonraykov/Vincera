"""Tests for vincera.core.message_poller — MessagePoller."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from vincera.core.message_poller import MessagePoller


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _run(coro):
    return asyncio.run(coro)


def _mock_handler() -> MagicMock:
    h = MagicMock()
    h.handle = AsyncMock()
    return h


def _mock_supabase(messages: list | None = None) -> MagicMock:
    sb = MagicMock()
    sb.get_new_messages.return_value = messages or []
    return sb


def _build_poller(handler=None, supabase=None, company_id="comp-1") -> MessagePoller:
    return MessagePoller(
        handler=handler or _mock_handler(),
        supabase=supabase or _mock_supabase(),
        company_id=company_id,
    )


# ===========================================================================
# poll_once
# ===========================================================================


class TestPollOnce:
    def test_no_messages(self) -> None:
        poller = _build_poller()
        count = _run(poller._poll_once())
        assert count == 0

    def test_processes_messages(self) -> None:
        messages = [
            {"id": "m-1", "sender": "user", "content": "hi", "created_at": "2026-01-01T00:00:01Z"},
            {"id": "m-2", "sender": "user", "content": "hello", "created_at": "2026-01-01T00:00:02Z"},
            {"id": "m-3", "sender": "user", "content": "yo", "created_at": "2026-01-01T00:00:03Z"},
        ]
        handler = _mock_handler()
        sb = _mock_supabase(messages)
        poller = _build_poller(handler=handler, supabase=sb)
        count = _run(poller._poll_once())
        assert count == 3
        assert handler.handle.await_count == 3

    def test_updates_last_poll(self) -> None:
        messages = [
            {"id": "m-1", "sender": "user", "content": "hi", "created_at": "2026-01-01T00:00:01Z"},
            {"id": "m-2", "sender": "user", "content": "yo", "created_at": "2026-01-01T00:00:05Z"},
        ]
        sb = _mock_supabase(messages)
        poller = _build_poller(supabase=sb)
        _run(poller._poll_once())
        assert poller._last_poll == "2026-01-01T00:00:05Z"

    def test_handles_handler_error(self) -> None:
        messages = [
            {"id": "m-1", "sender": "user", "content": "hi", "created_at": "2026-01-01T00:00:01Z"},
            {"id": "m-2", "sender": "user", "content": "boom", "created_at": "2026-01-01T00:00:02Z"},
            {"id": "m-3", "sender": "user", "content": "yo", "created_at": "2026-01-01T00:00:03Z"},
        ]
        handler = _mock_handler()
        # Second message raises
        call_count = {"n": 0}
        original_handle = handler.handle

        async def _side_effect(msg):
            call_count["n"] += 1
            if call_count["n"] == 2:
                raise ValueError("boom")

        handler.handle = AsyncMock(side_effect=_side_effect)
        sb = _mock_supabase(messages)
        poller = _build_poller(handler=handler, supabase=sb)
        count = _run(poller._poll_once())
        # 2 succeeded (1st and 3rd), 1 errored
        assert count == 2
        assert handler.handle.await_count == 3


# ===========================================================================
# message count
# ===========================================================================


class TestMessageCount:
    def test_accumulates(self) -> None:
        messages = [
            {"id": "m-1", "sender": "user", "content": "a", "created_at": "2026-01-01T00:00:01Z"},
            {"id": "m-2", "sender": "user", "content": "b", "created_at": "2026-01-01T00:00:02Z"},
        ]
        sb = _mock_supabase(messages)
        poller = _build_poller(supabase=sb)
        _run(poller._poll_once())
        assert poller.messages_processed == 2
        # Poll again with same messages
        _run(poller._poll_once())
        assert poller.messages_processed == 4


# ===========================================================================
# stop
# ===========================================================================


class TestStop:
    def test_stop(self) -> None:
        poller = _build_poller()
        poller._running = True
        poller.stop()
        assert poller.is_running is False


# ===========================================================================
# start
# ===========================================================================


class TestStart:
    def test_start_sets_running(self) -> None:
        poller = _build_poller()

        async def _short_run():
            # Start in a task, then immediately stop
            task = asyncio.create_task(poller.start())
            await asyncio.sleep(0.05)
            assert poller.is_running is True
            poller.stop()
            await task

        _run(_short_run())
        assert poller.is_running is False
