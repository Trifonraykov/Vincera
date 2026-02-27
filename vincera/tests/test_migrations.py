"""Tests for supabase/migrations — validate SQL migration files."""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "supabase" / "migrations"

EXPECTED_FILES = [
    "001_companies.sql",
    "002_agent_statuses.sql",
    "003_automations.sql",
    "004_events.sql",
    "005_messages.sql",
    "006_knowledge.sql",
    "007_decisions.sql",
    "008_playbook_entries.sql",
    "009_corrections.sql",
    "010_research.sql",
    "011_brain_states.sql",
    "012_ghost_reports.sql",
    "013_metrics.sql",
    "014_cross_company_patterns.sql",
    "015_rls_policies.sql",
    "016_indexes.sql",
    "017_functions.sql",
]

ALL_TABLES_WITH_COMPANY_ID = [
    "agent_statuses",
    "automations",
    "events",
    "messages",
    "knowledge",
    "decisions",
    "playbook_entries",
    "corrections",
    "research_sources",
    "research_insights",
    "brain_states",
    "ghost_reports",
    "metrics",
    "cross_company_patterns",
]

ALL_TABLES = ["companies"] + ALL_TABLES_WITH_COMPANY_ID


def _read(filename: str) -> str:
    return (MIGRATIONS_DIR / filename).read_text(encoding="utf-8")


def _read_all() -> str:
    """Concatenate all migration files."""
    parts = []
    for f in EXPECTED_FILES:
        parts.append(_read(f))
    return "\n".join(parts)


# ===========================================================================
# File existence and ordering
# ===========================================================================


class TestFileStructure:
    def test_all_migration_files_exist(self) -> None:
        for fname in EXPECTED_FILES:
            path = MIGRATIONS_DIR / fname
            assert path.exists(), f"Missing migration file: {fname}"
            assert path.stat().st_size > 0, f"Empty migration file: {fname}"

    def test_migration_files_ordered(self) -> None:
        files = sorted(f.name for f in MIGRATIONS_DIR.glob("*.sql"))
        for i, fname in enumerate(files, 1):
            prefix = fname.split("_")[0]
            assert prefix == f"{i:03d}", f"File {fname} has unexpected prefix (expected {i:03d})"


# ===========================================================================
# Table schemas
# ===========================================================================


class TestTableSchemas:
    def test_companies_table(self) -> None:
        sql = _read("001_companies.sql")
        assert "CREATE TABLE IF NOT EXISTS companies" in sql
        for col in ("id", "name", "status", "authority_level", "ghost_mode_until"):
            assert col in sql, f"companies table missing column: {col}"

    def test_messages_table(self) -> None:
        sql = _read("005_messages.sql")
        assert "CREATE TABLE IF NOT EXISTS messages" in sql
        for col in ("company_id", "sender", "content", "message_type", "read"):
            assert col in sql, f"messages table missing column: {col}"

    def test_all_tables_have_company_id(self) -> None:
        """Every table except companies itself must have a company_id column."""
        for table in ALL_TABLES_WITH_COMPANY_ID:
            # Find the file that creates this table
            found = False
            for fname in EXPECTED_FILES:
                sql = _read(fname)
                if f"CREATE TABLE IF NOT EXISTS {table}" in sql:
                    assert "company_id" in sql, f"{table} missing company_id"
                    found = True
                    break
            assert found, f"No migration creates table {table}"

    def test_all_tables_have_created_at(self) -> None:
        all_sql = _read_all()
        for table in ALL_TABLES:
            # Find the CREATE TABLE block for this table
            pattern = rf"CREATE TABLE IF NOT EXISTS {table}\s*\("
            match = re.search(pattern, all_sql)
            assert match, f"CREATE TABLE for {table} not found"
            # Grab everything until the closing );
            start = match.start()
            end = all_sql.find(");", start)
            block = all_sql[start : end + 2]
            assert "created_at" in block, f"{table} missing created_at"

    def test_all_tables_idempotent(self) -> None:
        all_sql = _read_all()
        create_stmts = re.findall(r"CREATE TABLE\b.*?\(", all_sql, re.IGNORECASE)
        for stmt in create_stmts:
            assert "IF NOT EXISTS" in stmt.upper(), f"Non-idempotent: {stmt.strip()}"

    def test_metrics_unique_constraint(self) -> None:
        sql = _read("013_metrics.sql")
        assert "UNIQUE" in sql
        assert "company_id" in sql
        assert "metric_name" in sql
        assert "metric_date" in sql

    def test_agent_statuses_unique(self) -> None:
        sql = _read("002_agent_statuses.sql")
        assert "UNIQUE" in sql
        assert "company_id" in sql
        assert "agent_name" in sql

    def test_foreign_keys(self) -> None:
        """Tables with company_id should reference companies(id) ON DELETE CASCADE."""
        for table in ALL_TABLES_WITH_COMPANY_ID:
            for fname in EXPECTED_FILES:
                sql = _read(fname)
                if f"CREATE TABLE IF NOT EXISTS {table}" in sql:
                    assert "REFERENCES companies(id)" in sql, (
                        f"{table} missing FK to companies"
                    )
                    assert "ON DELETE CASCADE" in sql, (
                        f"{table} missing ON DELETE CASCADE"
                    )
                    break


# ===========================================================================
# RLS policies
# ===========================================================================


class TestRLS:
    def test_rls_enabled_all_tables(self) -> None:
        sql = _read("015_rls_policies.sql")
        for table in ALL_TABLES:
            assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY" in sql, (
                f"RLS not enabled on {table}"
            )

    def test_rls_policies_exist(self) -> None:
        sql = _read("015_rls_policies.sql")
        # Messages INSERT policy
        assert "messages" in sql
        assert "INSERT" in sql
        # Decisions UPDATE policy
        assert "decisions" in sql
        assert "UPDATE" in sql


# ===========================================================================
# Indexes
# ===========================================================================


class TestIndexes:
    def test_indexes_exist(self) -> None:
        sql = _read("016_indexes.sql")
        index_stmts = re.findall(r"CREATE INDEX IF NOT EXISTS", sql, re.IGNORECASE)
        assert len(index_stmts) >= 10, (
            f"Expected >= 10 indexes, found {len(index_stmts)}"
        )


# ===========================================================================
# Functions
# ===========================================================================


class TestFunctions:
    def test_functions_exist(self) -> None:
        sql = _read("017_functions.sql")
        for fn in (
            "update_updated_at",
            "increment_metric",
            "clean_old_events",
            "get_latest_brain_state",
        ):
            assert fn in sql, f"Function {fn} not found in 017"


# ===========================================================================
# apply_migrations.py
# ===========================================================================


class TestApplyMigrations:
    def test_script_exists(self) -> None:
        script = MIGRATIONS_DIR.parent / "apply_migrations.py"
        assert script.exists(), "supabase/apply_migrations.py missing"

    def test_get_migration_files(self) -> None:
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "apply_migrations",
            str(MIGRATIONS_DIR.parent / "apply_migrations.py"),
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        files = mod.get_migration_files(str(MIGRATIONS_DIR))
        assert len(files) == 17
        # Verify sorted order
        basenames = [os.path.basename(f) for f in files]
        assert basenames == sorted(basenames)
