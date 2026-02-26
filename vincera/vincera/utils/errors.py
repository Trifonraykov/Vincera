"""Structured exception hierarchy for all Vincera errors."""

from __future__ import annotations


class VinceraError(Exception):
    """Base exception for all Vincera errors."""

    def __init__(
        self,
        message: str,
        agent_name: str | None = None,
        context: dict | None = None,
    ) -> None:
        self.agent_name = agent_name
        self.context = context or {}
        super().__init__(message)


class ConfigError(VinceraError):
    """Configuration loading, validation, or encryption errors."""


class LLMError(VinceraError):
    """OpenRouter API errors — timeout, rate limit, invalid response."""


class LLMCircuitOpenError(LLMError):
    """Circuit breaker is open — LLM calls blocked during cooldown."""


class DiscoveryError(VinceraError):
    """Discovery scan failures — permission denied, timeout, parse error."""


class ResearchError(VinceraError):
    """Research agent failures — source fetch, insight extraction."""


class VerificationError(VinceraError):
    """Verification pipeline failures — fact check, safety, confidence."""


class SandboxError(VinceraError):
    """Docker sandbox failures — container start, timeout, resource limit."""


class DeploymentError(VinceraError):
    """Deployment pipeline failures — promote, rollback, health check."""


class SupabaseError(VinceraError):
    """Supabase connection, query, or sync failures."""


class GhostModeError(VinceraError):
    """Ghost mode controller errors — invalid state transitions."""


class AuthorityError(VinceraError):
    """Authority level violation — attempted prohibited action."""


class ResourceError(VinceraError):
    """System resource exhaustion — disk, memory, CPU."""
