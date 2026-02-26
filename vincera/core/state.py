"""Dual-write state manager: local SQLite (source of truth) + Supabase (sync)."""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path

from vincera.knowledge.supabase_client import SupabaseManager
from vincera.utils.db import VinceraDB

logger = logging.getLogger(__name__)

_AGENT_STATUSES_TABLE = """\
CREATE TABLE IF NOT EXISTS agent_statuses (
    agent_name TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    current_task TEXT NOT NULL,
    detail TEXT,
    updated_at TEXT NOT NULL
)
"""

_PENDING_DECISIONS_TABLE = """\
CREATE TABLE IF NOT EXISTS pending_decisions (
    decision_id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    question TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
)
"""

_ACTION_HISTORY_TABLE = """\
CREATE TABLE IF NOT EXISTS action_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target TEXT NOT NULL,
    result TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
)
"""

_MESSAGE_QUEUE_TABLE = """\
CREATE TABLE IF NOT EXISTS message_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
)
"""

_GLOBAL_FLAGS_TABLE = """\
CREATE TABLE IF NOT EXISTS global_flags (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)
"""


class GlobalState:
    """Dual-write state manager with offline queue for Supabase failures."""

    def __init__(
        self,
        db_path: Path,
        supabase_manager: SupabaseManager,
    ) -> None:
        self._db = VinceraDB(db_path)
        self._sb = supabase_manager
        self._lock = threading.Lock()
        self._init_tables()

    def _init_tables(self) -> None:
        for ddl in (
            _AGENT_STATUSES_TABLE,
            _PENDING_DECISIONS_TABLE,
            _ACTION_HISTORY_TABLE,
            _MESSAGE_QUEUE_TABLE,
            _GLOBAL_FLAGS_TABLE,
        ):
            self._db.execute(ddl)

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    # ------------------------------------------------------------------
    # Supabase write with queue fallback
    # ------------------------------------------------------------------

    def _try_supabase(self, method_name: str, **kwargs: object) -> None:
        """Call a SupabaseManager method; queue on failure."""
        try:
            fn = getattr(self._sb, method_name)
            fn(**kwargs)
        except Exception as exc:
            logger.warning("Supabase %s failed, queuing: %s", method_name, exc)
            self._enqueue(method_name, kwargs)

    def _enqueue(self, method_name: str, kwargs: dict) -> None:
        payload = json.dumps({"method": method_name, "kwargs": _serialize(kwargs)})
        self._db.execute(
            "INSERT INTO message_queue (payload, created_at) VALUES (?, ?)",
            (payload, self._now()),
        )

    # ------------------------------------------------------------------
    # Agent statuses
    # ------------------------------------------------------------------

    def update_agent_status(
        self,
        agent_name: str,
        status: str,
        task: str,
        detail: str | None = None,
    ) -> None:
        now = self._now()
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO agent_statuses (agent_name, status, current_task, detail, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (agent_name, status, task, detail, now),
            )
        self._try_supabase(
            "update_agent_status",
            company_id=self._sb._company_id,
            agent_name=agent_name,
            status=status,
            task=task,
            detail=detail,
        )

    def get_agent_status(self, agent_name: str) -> dict | None:
        rows = self._db.query(
            "SELECT * FROM agent_statuses WHERE agent_name = ?", (agent_name,)
        )
        return rows[0] if rows else None

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def add_action(
        self,
        agent_name: str,
        action_type: str,
        target: str,
        result: str,
        detail: str | None = None,
    ) -> None:
        now = self._now()
        with self._lock:
            self._db.execute(
                "INSERT INTO action_history (agent_name, action_type, target, result, detail, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (agent_name, action_type, target, result, detail, now),
            )
        self._try_supabase(
            "log_event",
            company_id=self._sb._company_id,
            event_type=action_type,
            agent_name=agent_name,
            message=f"{action_type} on {target}: {result}",
            severity="info",
            metadata={"target": target, "result": result, "detail": detail},
        )

    # ------------------------------------------------------------------
    # Decisions
    # ------------------------------------------------------------------

    def add_pending_decision(
        self,
        decision_id: str,
        agent_name: str,
        question: str,
    ) -> None:
        now = self._now()
        with self._lock:
            self._db.execute(
                "INSERT INTO pending_decisions (decision_id, agent_name, question, status, created_at) "
                "VALUES (?, ?, ?, 'pending', ?)",
                (decision_id, agent_name, question, now),
            )
        self._try_supabase(
            "create_decision",
            company_id=self._sb._company_id,
            agent_name=agent_name,
            question=question,
            option_a="",
            option_b="",
            context="",
        )

    def resolve_decision(
        self,
        decision_id: str,
        choice: str,
        note: str | None = None,
    ) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE pending_decisions SET status = 'resolved' WHERE decision_id = ?",
                (decision_id,),
            )
        self._try_supabase(
            "resolve_decision",
            decision_id=decision_id,
            chosen_option=choice,
            note=note,
        )

    def get_pending_decisions(self) -> list[dict]:
        return self._db.query(
            "SELECT * FROM pending_decisions WHERE status = 'pending'"
        )

    # ------------------------------------------------------------------
    # Pause flag
    # ------------------------------------------------------------------

    def is_paused(self) -> bool:
        rows = self._db.query(
            "SELECT value FROM global_flags WHERE key = 'paused'"
        )
        if rows:
            return rows[0]["value"] == "true"
        return False

    def set_paused(self, paused: bool) -> None:
        val = "true" if paused else "false"
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO global_flags (key, value) VALUES ('paused', ?)",
                (val,),
            )
        self._try_supabase(
            "update_company",
            company_id=self._sb._company_id,
            fields={"paused": paused},
        )

    # ------------------------------------------------------------------
    # Queue flush
    # ------------------------------------------------------------------

    def flush_queue(self) -> int:
        """Replay queued Supabase writes. Returns count of successfully flushed items."""
        rows = self._db.query("SELECT id, payload FROM message_queue ORDER BY id ASC")
        flushed = 0
        for row in rows:
            try:
                entry = json.loads(row["payload"])
                method_name = entry["method"]
                kwargs = entry["kwargs"]
                fn = getattr(self._sb, method_name)
                fn(**kwargs)
                self._db.execute("DELETE FROM message_queue WHERE id = ?", (row["id"],))
                flushed += 1
            except Exception as exc:
                logger.warning("flush_queue: failed to replay %s: %s", row["id"], exc)
                break  # Stop on first failure — retry later
        return flushed

    # ------------------------------------------------------------------
    # Snapshot
    # ------------------------------------------------------------------

    def save_snapshot(self, path: Path) -> None:
        """Dump full local state to a JSON file."""
        data = {
            "agent_statuses": self._db.query("SELECT * FROM agent_statuses"),
            "pending_decisions": self._db.query("SELECT * FROM pending_decisions"),
            "action_history": self._db.query("SELECT * FROM action_history"),
            "global_flags": self._db.query("SELECT * FROM global_flags"),
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def load_snapshot(self, path: Path) -> None:
        """Restore state from a JSON snapshot file."""
        data = json.loads(path.read_text(encoding="utf-8"))

        with self._lock:
            for row in data.get("agent_statuses", []):
                self._db.execute(
                    "INSERT OR REPLACE INTO agent_statuses (agent_name, status, current_task, detail, updated_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (row["agent_name"], row["status"], row["current_task"], row.get("detail"), row["updated_at"]),
                )
            for row in data.get("pending_decisions", []):
                self._db.execute(
                    "INSERT OR REPLACE INTO pending_decisions (decision_id, agent_name, question, status, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (row["decision_id"], row["agent_name"], row["question"], row["status"], row["created_at"]),
                )
            for row in data.get("action_history", []):
                self._db.execute(
                    "INSERT INTO action_history (agent_name, action_type, target, result, detail, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (row["agent_name"], row["action_type"], row["target"], row["result"], row.get("detail"), row["created_at"]),
                )
            for row in data.get("global_flags", []):
                self._db.execute(
                    "INSERT OR REPLACE INTO global_flags (key, value) VALUES (?, ?)",
                    (row["key"], row["value"]),
                )


def _serialize(obj: object) -> object:
    """Make kwargs JSON-serializable (convert Path objects etc.)."""
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialize(item) for item in obj]
    if isinstance(obj, Path):
        return str(obj)
    return obj
