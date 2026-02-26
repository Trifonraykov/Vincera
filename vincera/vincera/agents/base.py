"""Abstract base agent class — foundation for all Vincera agents."""

from __future__ import annotations

import asyncio
import json
import logging
import traceback
from abc import ABC, abstractmethod
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING

from vincera.utils.errors import VinceraError

if TYPE_CHECKING:
    from vincera.config import VinceraSettings
    from vincera.core.llm import OpenRouterClient
    from vincera.core.state import GlobalState
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.verification.verifier import Verifier, VerificationResult

from vincera.knowledge.playbook import PlaybookManager

logger = logging.getLogger(__name__)


class AgentStatus(str, Enum):
    """Possible states for an agent."""

    IDLE = "idle"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    BLOCKED = "blocked"


class BaseAgent(ABC):
    """Abstract base agent that all Vincera agents extend.

    Provides: chat, playbook, verification, approval, lifecycle management.
    """

    def __init__(
        self,
        name: str,
        company_id: str,
        config: "VinceraSettings",
        llm: "OpenRouterClient",
        supabase: "SupabaseManager",
        state: "GlobalState",
        verifier: "Verifier",
    ) -> None:
        self._name = name
        self._company_id = company_id
        self._config = config
        self._llm = llm
        self._sb = supabase
        self._state = state
        self._verifier = verifier
        self._status = AgentStatus.IDLE
        self._current_task: str | None = None

        # Playbook manager
        self._playbook = PlaybookManager(supabase, llm)

        # Workspace directory
        self._workspace_dir = config.home_dir / "agents" / name
        self._workspace_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def name(self) -> str:
        return self._name

    @property
    def status(self) -> AgentStatus:
        return self._status

    @property
    def company_id(self) -> str:
        return self._company_id

    @property
    def workspace_dir(self) -> Path:
        return self._workspace_dir

    @property
    def playbook(self) -> PlaybookManager:
        return self._playbook

    # ------------------------------------------------------------------
    # Abstract method — each agent implements this
    # ------------------------------------------------------------------

    @abstractmethod
    async def run(self, task: dict) -> dict:
        """Execute the agent's core logic. Subclasses must implement."""
        ...

    # ------------------------------------------------------------------
    # Lifecycle — wraps run() with status management
    # ------------------------------------------------------------------

    async def execute(self, task: dict) -> dict:
        """Execute a task with full lifecycle management.

        Sets status to RUNNING, calls run(), sets COMPLETED or FAILED.
        NOT abstract — agents should not override this.
        """
        self._status = AgentStatus.RUNNING
        self._current_task = task.get("type", str(task))
        self._state.update_agent_status(self._name, "running", self._current_task)

        try:
            result = await self.run(task)
            self._status = AgentStatus.COMPLETED
            self._state.update_agent_status(self._name, "completed", self._current_task)
            return result
        except VinceraError as exc:
            self._status = AgentStatus.FAILED
            self._state.update_agent_status(
                self._name, "failed", self._current_task, f"{type(exc).__name__}: {exc}",
            )
            await self._report_error(exc)
            raise
        except Exception as exc:
            self._status = AgentStatus.FAILED
            self._state.update_agent_status(
                self._name, "failed", self._current_task, f"Unexpected: {type(exc).__name__}",
            )
            wrapped = VinceraError(
                f"Unexpected error in {self._name}: {exc}",
                agent_name=self._name,
                context={
                    "original_type": type(exc).__name__,
                    "traceback": traceback.format_exc(),
                },
            )
            await self._report_error(wrapped)
            raise wrapped from exc

    async def _report_error(self, error: VinceraError) -> None:
        """Send error details to the agent's chat and log as event.

        Wrapped in try/except — error reporting must never cascade.
        """
        try:
            error_msg = f"Error in {self._name}: {error}"
            if error.context:
                error_msg += f"\n\nContext: {json.dumps(error.context, indent=2, default=str)}"

            self._sb.send_message(
                self._company_id,
                self._name,
                error_msg,
                "alert",
                {
                    "error_type": type(error).__name__,
                    "agent_name": error.agent_name or self._name,
                    "context": error.context,
                },
            )

            self._sb.log_event(
                company_id=self._company_id,
                event_type="agent_error",
                agent_name=self._name,
                message=str(error),
                severity="error",
                metadata=error.context,
            )
        except Exception:
            logger.exception("Failed to report error for %s", self._name)

    # ------------------------------------------------------------------
    # Chat capability
    # ------------------------------------------------------------------

    async def handle_message(self, user_message: str) -> str:
        """Handle a user message from the dashboard chat."""
        try:
            context = await self.get_context()
            recent_actions = context.get("recent_actions", [])

            system_prompt = (
                f"You are the {self._name} agent for {self._config.company_name}. "
                "The user is chatting with you through the Vincera dashboard. "
                "Be conversational, specific, and honest. If you don't know something, say so. "
                "Reference specific actions you've taken, data you've seen, and decisions you've made.\n\n"
                f"Your current state: {self._status.value}\n"
                f"Your recent actions: {recent_actions}\n"
                f"Your current task: {self._current_task or 'none'}"
            )

            response = await self._llm.think(
                system_prompt=system_prompt,
                user_message=user_message,
            )

            # Send response to Supabase chat
            self._sb.send_message(
                self._company_id,
                self._name,
                response,
                "chat",
            )

            return response
        except Exception as exc:
            error_response = (
                f"Sorry, I encountered an error while processing your message: "
                f"{type(exc).__name__}"
            )
            logger.exception("Error in %s.handle_message", self._name)
            try:
                self._sb.send_message(
                    self._company_id, self._name, error_response, "error",
                )
            except Exception:
                pass  # Don't cascade
            return error_response

    # ------------------------------------------------------------------
    # Playbook integration
    # ------------------------------------------------------------------

    async def consult_playbook(self, task_description: str) -> list[dict]:
        """Look up relevant playbook entries for a task."""
        return await self._playbook.consult(self._company_id, self._name, task_description)

    async def record_to_playbook(
        self,
        action_type: str,
        context: str,
        approach: str,
        outcome: str,
        success: bool,
        lessons: str,
    ) -> dict | None:
        """Record an entry to the playbook."""
        return await self._playbook.record(
            company_id=self._company_id,
            agent_name=self._name,
            action_type=action_type,
            context_summary=context,
            approach=approach,
            outcome=outcome,
            success=success,
            lessons_learned=lessons,
        )

    # ------------------------------------------------------------------
    # Standard capabilities
    # ------------------------------------------------------------------

    async def log_action(
        self,
        action_type: str,
        target: str,
        result: str,
        detail: str | None = None,
    ) -> None:
        """Log an action to state (dual-write to SQLite + Supabase events)."""
        self._state.add_action(self._name, action_type, target, result, detail)

    async def request_verification(self, action: dict) -> "VerificationResult":
        """Pass an action through the verification pipeline."""
        context = await self.get_context()
        return await self._verifier.verify(action, context)

    async def request_approval(
        self,
        question: str,
        option_a: str,
        option_b: str,
        context: str,
        risk_level: str = "low",
        poll_interval: float = 10.0,
        timeout: float = 86400.0,
    ) -> str:
        """Create a decision and poll until resolved.

        Returns the chosen option string, or "expired" on timeout.
        """
        decision_id = self._sb.create_decision(
            company_id=self._company_id,
            agent_name=self._name,
            question=question,
            option_a=option_a,
            option_b=option_b,
            context=context,
            risk_level=risk_level,
        )

        if decision_id is None:
            logger.error("Failed to create decision for %s", self._name)
            return "error"

        # Send the question as a chat message
        self._sb.send_message(
            self._company_id,
            self._name,
            question,
            "decision",
        )

        # Poll until resolved or timeout
        elapsed = 0.0
        while elapsed < timeout:
            result = self._sb.poll_decision(decision_id)
            if result and result.get("status") == "resolved":
                return result.get("chosen_option", "unknown")
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

        return "expired"

    async def send_message(
        self,
        content: str,
        message_type: str = "chat",
        metadata: dict | None = None,
    ) -> dict | None:
        """Send a message through Supabase."""
        return self._sb.send_message(
            self._company_id,
            self._name,
            content,
            message_type,
            metadata,
        )

    async def get_context(self) -> dict:
        """Assemble current context for the agent."""
        agent_status = self._state.get_agent_status(self._name)
        recent_actions = self._state._db.query(
            "SELECT * FROM action_history WHERE agent_name = ? ORDER BY id DESC LIMIT 10",
            (self._name,),
        )
        knowledge = self._sb.query_knowledge(self._company_id)

        return {
            "agent_status": agent_status,
            "recent_actions": recent_actions,
            "knowledge": knowledge,
            "company_id": self._company_id,
            "agent_name": self._name,
        }
