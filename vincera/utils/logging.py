"""Structured JSON-lines logging with daily rotation and secret redaction."""

from __future__ import annotations

import json
import logging
import re
import sys
from datetime import datetime, timezone
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path


class SecretRedactionFilter(logging.Filter):
    """Redacts sensitive values from log messages."""

    PATTERNS: list[tuple[str, str]] = [
        # API keys (OpenRouter, etc.) — sk-or-... followed by 20+ alphanumeric
        (r"sk-or-[a-zA-Z0-9]{20,}", "***REDACTED_API_KEY***"),
        # JWT-like tokens (Supabase keys) — eyJ...eyJ...signature
        (r"eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+", "***REDACTED_TOKEN***"),
        # Known secret field names: key=value or key: value
        (
            r"((?:api_key|service_key|service_role|secret_key|password|token|authorization)"
            r"\s*[=:]\s*)[^\s,\}\"']+",
            r"\1***",
        ),
        # Connection strings with credentials
        (r"((?:postgres|mysql|redis|mongodb)://[^:]+:)[^@]+(@)", r"\1***\2"),
        # Supabase URL apikey query param
        (r"(apikey=)[^\s&]+", r"\1***"),
    ]

    def __init__(self) -> None:
        super().__init__()
        self._compiled = [(re.compile(p), r) for p, r in self.PATTERNS]

    def filter(self, record: logging.LogRecord) -> bool:
        """Modify the log record to redact secrets. Always returns True."""
        if isinstance(record.msg, str):
            record.msg = self._redact(record.msg)
        if record.args:
            record.args = tuple(
                self._redact(str(a)) if isinstance(a, str) else a
                for a in record.args
            )
        return True

    def _redact(self, text: str) -> str:
        for pattern, replacement in self._compiled:
            text = pattern.sub(replacement, text)
        return text


class JsonFormatter(logging.Formatter):
    """Formats each log record as a single JSON line."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info and record.exc_info[1] is not None:
            entry["exception"] = self.formatException(record.exc_info)
        # Include any extra fields attached to the record
        for key in ("agent_name", "company_id", "event_type", "detail"):
            val = getattr(record, key, None)
            if val is not None:
                entry[key] = val
        return json.dumps(entry, default=str)


def setup_logging(logs_dir: Path, level: str = "INFO") -> None:
    """Configure root logger with JSON file handler and console handler.

    Args:
        logs_dir: Directory for log files (created if needed).
        level: Log level string (DEBUG, INFO, WARNING, ERROR).
    """
    logs_dir.mkdir(parents=True, exist_ok=True)

    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Avoid duplicate handlers on repeated calls
    if any(getattr(h, "_vincera_json", False) for h in root.handlers):
        return

    # Secret redaction filter — attached to all handlers
    redaction_filter = SecretRedactionFilter()

    # JSON file handler — daily rotation, keep 30 days
    file_handler = TimedRotatingFileHandler(
        filename=str(logs_dir / "vincera.log"),
        when="midnight",
        backupCount=30,
        encoding="utf-8",
    )
    file_handler.setFormatter(JsonFormatter())
    file_handler.addFilter(redaction_filter)
    file_handler._vincera_json = True  # type: ignore[attr-defined]
    root.addHandler(file_handler)

    # Console handler — simple format for humans
    console_handler = logging.StreamHandler(sys.stderr)
    console_fmt = logging.Formatter("%(asctime)s %(levelname)-8s %(name)s — %(message)s", datefmt="%H:%M:%S")
    console_handler.setFormatter(console_fmt)
    console_handler.addFilter(redaction_filter)
    console_handler._vincera_json = True  # type: ignore[attr-defined]
    root.addHandler(console_handler)


def get_logger(name: str) -> logging.Logger:
    """Return a logger with the given name."""
    return logging.getLogger(name)
