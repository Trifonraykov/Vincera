"""Message handler — routes incoming dashboard messages to agents or orchestrator."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vincera.agents.base import BaseAgent
    from vincera.core.orchestrator import Orchestrator
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.training.corrections import CorrectionTracker

logger = logging.getLogger(__name__)


class MessageHandler:
    """Routes incoming messages to the correct agent or orchestrator command."""

    AGENT_KEYWORDS: dict[str, list[str]] = {
        "discovery": ["discover", "scan", "map", "what software", "what's installed"],
        "research": ["research", "study", "find papers", "academic", "best practices"],
        "builder": ["build", "create", "automate", "make a script", "write code"],
        "operator": ["run", "execute", "deploy", "canary", "health check"],
        "analyst": ["analyze", "performance", "report", "trend", "optimize"],
        "unstuck": ["fix", "broken", "error", "stuck", "debug", "failing"],
        "trainer": ["learn", "correct", "wrong", "mistake", "train"],
    }

    SYSTEM_COMMANDS: dict[str, list[str]] = {
        "status": ["status", "what are you doing", "progress", "where are you"],
        "pause": ["pause", "stop", "hold", "wait"],
        "resume": ["resume", "continue", "go", "start"],
        "backlog": ["backlog", "priority", "what's next", "queue"],
        "authority": ["authority", "permission", "trust level"],
        "help": ["help", "what can you do", "commands"],
    }

    _CORRECTION_SIGNALS = [
        "that's wrong", "that is wrong", "no, ", "incorrect",
        "don't do it that way", "do it like this", "you should have",
        "fix that", "that's not right", "not what i asked",
        "wrong approach", "bad output",
    ]

    def __init__(
        self,
        orchestrator: "Orchestrator",
        agents: dict[str, "BaseAgent"],
        corrections: "CorrectionTracker",
        supabase: "SupabaseManager",
        company_id: str,
    ) -> None:
        self._orchestrator = orchestrator
        self._agents = agents
        self._corrections = corrections
        self._sb = supabase
        self._company_id = company_id

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    async def handle(self, message: dict) -> None:
        """Handle an incoming message from the dashboard."""
        content = message.get("content", "")
        msg_type = message.get("message_type", "chat")
        metadata = message.get("metadata", {}) or {}
        sender = message.get("sender", "user")

        # Ignore messages from agents (prevent loops)
        if sender != "user":
            return

        # Handle corrections
        if msg_type == "correction" or self._is_correction(content):
            await self._handle_correction(content, metadata)
            return

        # Handle decision responses
        if msg_type == "decision_response":
            self._handle_decision_response(metadata)
            return

        # Handle system commands
        command = self._match_system_command(content)
        if command:
            await self._handle_system_command(command, content)
            return

        # Route to specific agent — prefer explicit target_agent from dashboard
        agent_name = metadata.get("target_agent") or self._route_to_agent(content, metadata)
        if agent_name and agent_name in self._agents:
            await self._agents[agent_name].handle_message(content)
            return

        # Default: let orchestrator handle it
        await self._orchestrator.handle_user_message(content)

    # ------------------------------------------------------------------
    # Correction handling
    # ------------------------------------------------------------------

    def _is_correction(self, content: str) -> bool:
        """Detect if message is a correction."""
        lower = content.lower()
        return any(signal in lower for signal in self._CORRECTION_SIGNALS)

    async def _handle_correction(self, content: str, metadata: dict) -> None:
        """Route correction to the CorrectionTracker."""
        agent_name = metadata.get("correcting_agent", "")
        original_action = metadata.get("original_action", "")

        if not agent_name:
            agent_name = self._route_to_agent(content, {}) or "orchestrator"

        await self._corrections.record_correction(agent_name, original_action, content)

        self._sb.send_message(
            self._company_id, "system",
            f"Correction noted for {agent_name}. I'll learn from this.",
            "chat", {},
        )

    # ------------------------------------------------------------------
    # Decision responses
    # ------------------------------------------------------------------

    def _handle_decision_response(self, metadata: dict) -> None:
        """Handle user's approval/denial of a decision."""
        decision_id = metadata.get("decision_id", "")
        resolution = metadata.get("resolution", "")

        if decision_id and resolution:
            self._sb.resolve_decision(decision_id, resolution)

    # ------------------------------------------------------------------
    # System commands
    # ------------------------------------------------------------------

    def _match_system_command(self, content: str) -> str | None:
        """Match content to a system command."""
        lower = content.lower().strip()
        for command, keywords in self.SYSTEM_COMMANDS.items():
            if any(kw in lower for kw in keywords):
                return command
        return None

    async def _handle_system_command(self, command: str, content: str) -> None:
        """Execute a system command."""
        if command in ("status", "pause", "resume", "backlog"):
            await self._orchestrator.handle_user_message(content)
        elif command == "authority":
            summary = self._orchestrator._authority.get_restrictions_summary()
            self._sb.send_message(
                self._company_id, "system",
                f"Current authority:\n{summary}", "chat", {},
            )
        elif command == "help":
            self._send_help()

    def _send_help(self) -> None:
        """Send help message listing capabilities."""
        help_text = (
            "Here's what I can do:\n\n"
            "**System commands:**\n"
            "- 'status' — see what I'm doing\n"
            "- 'pause' / 'resume' — control my activity\n"
            "- 'backlog' — see prioritised automation queue\n"
            "- 'authority' — see current permission level\n\n"
            "**Talk to specific agents:**\n"
            "- 'build ...' — ask builder to create an automation\n"
            "- 'analyze ...' — ask analyst for performance review\n"
            "- 'fix ...' — ask unstuck agent to diagnose an issue\n"
            "- 'research ...' — ask research agent to study a topic\n\n"
            "**Corrections:**\n"
            "- 'That's wrong, do it like this...' — I'll learn from corrections\n\n"
            "Or just chat — I'll figure out who should handle it."
        )
        self._sb.send_message(self._company_id, "system", help_text, "chat", {})

    # ------------------------------------------------------------------
    # Routing
    # ------------------------------------------------------------------

    def _route_to_agent(self, content: str, metadata: dict) -> str | None:
        """Determine which agent should handle this message."""
        # Explicit routing via metadata
        target = metadata.get("target_agent")
        if target and target in self._agents:
            return target

        # @mentions
        lower = content.lower()
        for agent_name in self._agents:
            if f"@{agent_name}" in lower:
                return agent_name

        # Keyword matching
        for agent_name, keywords in self.AGENT_KEYWORDS.items():
            if any(kw in lower for kw in keywords):
                return agent_name

        return None
