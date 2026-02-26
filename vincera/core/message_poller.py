"""Message poller — polls Supabase for new messages and feeds them to the handler."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vincera.core.message_handler import MessageHandler
    from vincera.knowledge.supabase_client import SupabaseManager

logger = logging.getLogger(__name__)


class MessagePoller:
    """Polls Supabase for new user messages and dispatches them."""

    def __init__(
        self,
        handler: "MessageHandler",
        supabase: "SupabaseManager",
        company_id: str,
        poll_interval: float = 2.0,
    ) -> None:
        self._handler = handler
        self._sb = supabase
        self._company_id = company_id
        self._poll_interval = poll_interval
        self._running: bool = False
        self._last_poll: str | None = None
        self._message_count: int = 0

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start the polling loop."""
        self._running = True
        logger.info("Message poller started")

        while self._running:
            try:
                await self._poll_once()
            except Exception as exc:
                logger.error("Message poller error: %s", exc)
            await asyncio.sleep(self._poll_interval)

    async def _poll_once(self) -> int:
        """Poll for new messages. Returns count of messages processed."""
        since = self._last_poll or datetime.min.replace(tzinfo=timezone.utc).isoformat()
        messages = self._sb.get_new_messages(self._company_id, since)

        if not messages:
            return 0

        count = 0
        for msg in messages:
            try:
                await self._handler.handle(msg)
                count += 1
                self._message_count += 1
            except Exception as exc:
                logger.error("Error handling message %s: %s", msg.get("id", "?"), exc)

        # Update last poll timestamp to the latest message
        latest = max(msg.get("created_at", "") for msg in messages)
        if latest:
            self._last_poll = latest

        return count

    # ------------------------------------------------------------------
    # Control
    # ------------------------------------------------------------------

    def stop(self) -> None:
        """Stop the polling loop."""
        self._running = False
        logger.info("Message poller stopped")

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def messages_processed(self) -> int:
        return self._message_count
