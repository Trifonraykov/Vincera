-- Custom migration: extensions the schema depends on. Runs before any table is created.
-- pgvector provides the vector(1024) embedding columns and HNSW indexes (CLAUDE.md §2, §5).
CREATE EXTENSION IF NOT EXISTS vector;
