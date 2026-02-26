"""Structured JSON-lines logging with daily rotation."""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path


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

    # JSON file handler — daily rotation, keep 30 days
    file_handler = TimedRotatingFileHandler(
        filename=str(logs_dir / "vincera.log"),
        when="midnight",
        backupCount=30,
        encoding="utf-8",
    )
    file_handler.setFormatter(JsonFormatter())
    file_handler._vincera_json = True  # type: ignore[attr-defined]
    root.addHandler(file_handler)

    # Console handler — simple format for humans
    console_handler = logging.StreamHandler(sys.stderr)
    console_fmt = logging.Formatter("%(asctime)s %(levelname)-8s %(name)s — %(message)s", datefmt="%H:%M:%S")
    console_handler.setFormatter(console_fmt)
    console_handler._vincera_json = True  # type: ignore[attr-defined]
    root.addHandler(console_handler)


def get_logger(name: str) -> logging.Logger:
    """Return a logger with the given name."""
    return logging.getLogger(name)
