"""Database discovery: detect databases and extract schema (never data)."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

from pydantic import BaseModel

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Models
# ------------------------------------------------------------------


class ColumnInfo(BaseModel):
    """A single database column."""

    name: str
    data_type: str


class TableSchema(BaseModel):
    """Schema of a single table/collection."""

    name: str
    columns: list[ColumnInfo] = []
    row_count: int = 0


class DatabaseSchema(BaseModel):
    """Full schema of a database."""

    database_name: str
    db_type: str
    tables: list[TableSchema] = []


class DatabaseInfo(BaseModel):
    """Information about a discovered database."""

    name: str
    db_type: str
    port: int | None = None
    version: str | None = None
    path: str | None = None


# ------------------------------------------------------------------
# Known process → DB mappings
# ------------------------------------------------------------------

_PROCESS_DB_MAP: dict[str, tuple[str, int]] = {
    "postgres": ("postgresql", 5432),
    "postgresql": ("postgresql", 5432),
    "mysql": ("mysql", 3306),
    "mysqld": ("mysql", 3306),
    "mariadbd": ("mysql", 3306),
    "mongod": ("mongodb", 27017),
    "sqlservr": ("mssql", 1433),
    "redis": ("redis", 6379),
    "redis-server": ("redis", 6379),
}


class DatabaseDiscovery:
    """Discovers databases and extracts schema metadata. Never reads data values."""

    async def discover_databases(self, processes: list[dict]) -> list[DatabaseInfo]:
        """Identify databases from running process list."""
        found: list[DatabaseInfo] = []
        seen_types: set[str] = set()

        for proc in processes:
            name = proc.get("name", "").lower()
            for key, (db_type, port) in _PROCESS_DB_MAP.items():
                if key == name or name.startswith(key):
                    if db_type not in seen_types:
                        seen_types.add(db_type)
                        version = None
                        cmdline = proc.get("cmdline", [])
                        if cmdline:
                            # Try to extract version from cmdline
                            for arg in cmdline:
                                if "version" in str(arg).lower():
                                    version = str(arg)
                                    break
                        found.append(DatabaseInfo(
                            name=name,
                            db_type=db_type,
                            port=port,
                            version=version,
                        ))

        return found

    async def extract_schema(self, db_info: DatabaseInfo) -> DatabaseSchema | None:
        """Extract schema from a database. NEVER reads actual data rows."""
        if db_info.db_type == "sqlite":
            return self._extract_sqlite_schema(db_info)
        elif db_info.db_type == "postgresql":
            return self._extract_postgresql_schema(db_info)
        elif db_info.db_type == "mysql":
            return self._extract_mysql_schema(db_info)
        else:
            logger.info("Schema extraction not supported for %s", db_info.db_type)
            return None

    def _extract_sqlite_schema(self, db_info: DatabaseInfo) -> DatabaseSchema | None:
        """Extract schema from a SQLite database."""
        if not db_info.path:
            return None
        try:
            conn = sqlite3.connect(db_info.path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            # Get table names (skip internal tables)
            cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
            table_names = [row["name"] for row in cursor.fetchall()]

            tables: list[TableSchema] = []
            for tname in table_names:
                # Get columns via PRAGMA
                cursor.execute(f"PRAGMA table_info('{tname}')")
                columns = [
                    ColumnInfo(name=row["name"], data_type=row["type"] or "TEXT")
                    for row in cursor.fetchall()
                ]

                # Get row count (COUNT only, no data)
                cursor.execute(f"SELECT COUNT(*) as cnt FROM '{tname}'")  # noqa: S608
                row_count = cursor.fetchone()["cnt"]

                tables.append(TableSchema(name=tname, columns=columns, row_count=row_count))

            conn.close()
            return DatabaseSchema(
                database_name=db_info.name,
                db_type="sqlite",
                tables=tables,
            )
        except Exception as exc:
            logger.warning("Failed to extract SQLite schema from %s: %s", db_info.path, exc)
            return None

    def _extract_postgresql_schema(self, db_info: DatabaseInfo) -> DatabaseSchema | None:
        """Extract schema from PostgreSQL. Requires psycopg2."""
        try:
            import psycopg2  # type: ignore[import-untyped]

            conn = psycopg2.connect(
                host="localhost", port=db_info.port or 5432, dbname="postgres",
            )
            cursor = conn.cursor()

            cursor.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
            )
            table_names = [row[0] for row in cursor.fetchall()]

            tables: list[TableSchema] = []
            for tname in table_names:
                cursor.execute(
                    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = %s",
                    (tname,),
                )
                columns = [ColumnInfo(name=row[0], data_type=row[1]) for row in cursor.fetchall()]
                cursor.execute(f"SELECT COUNT(*) FROM \"{tname}\"")  # noqa: S608
                row_count = cursor.fetchone()[0]
                tables.append(TableSchema(name=tname, columns=columns, row_count=row_count))

            conn.close()
            return DatabaseSchema(database_name=db_info.name, db_type="postgresql", tables=tables)
        except ImportError:
            logger.info("psycopg2 not installed, skipping PostgreSQL schema extraction")
            return None
        except Exception as exc:
            logger.warning("Failed to extract PostgreSQL schema: %s", exc)
            return None

    def _extract_mysql_schema(self, db_info: DatabaseInfo) -> DatabaseSchema | None:
        """Extract schema from MySQL. Requires mysql-connector-python."""
        try:
            import mysql.connector  # type: ignore[import-untyped]

            conn = mysql.connector.connect(
                host="localhost", port=db_info.port or 3306,
            )
            cursor = conn.cursor()
            cursor.execute("SHOW DATABASES")
            # Just return None for now if connection succeeds — full implementation later
            conn.close()
            return None
        except ImportError:
            logger.info("mysql-connector-python not installed, skipping MySQL schema extraction")
            return None
        except Exception as exc:
            logger.warning("Failed to extract MySQL schema: %s", exc)
            return None
