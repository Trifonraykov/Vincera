"""Thin thread-safe SQLite wrapper for Vincera Bot."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

_TOKEN_USAGE_TABLE = """\
CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    cost_estimate REAL NOT NULL,
    agent_name TEXT NOT NULL
)
"""


class VinceraDB:
    """Thread-safe SQLite database wrapper."""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._init_tables()

    def _init_tables(self) -> None:
        with self._lock:
            self._conn.execute(_TOKEN_USAGE_TABLE)
            self._conn.commit()

    def execute(self, sql: str, params: tuple = ()) -> int:
        """Execute a write statement. Returns lastrowid."""
        with self._lock:
            cursor = self._conn.execute(sql, params)
            self._conn.commit()
            return cursor.lastrowid  # type: ignore[return-value]

    def query(self, sql: str, params: tuple = ()) -> list[dict]:
        """Execute a read query. Returns list of row dicts."""
        with self._lock:
            cursor = self._conn.execute(sql, params)
            return [dict(row) for row in cursor.fetchall()]

    def close(self) -> None:
        """Close the database connection."""
        self._conn.close()
